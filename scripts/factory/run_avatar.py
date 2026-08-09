#!/usr/bin/env python3
"""Drive one avatar order through the connected factory line (①b).

Stages (skip with --from / --upto):
  expand   — template → prompt (writes back into a work copy)
  stand    — nano-banana-2 stand frame (unless order.skipStand / sheet exists)
  walk     — wan-2.7-i2v walk clip from the stand
  extract  — ffmpeg frames from the walk mp4
  select   — foot-phase auto selection of walk-a..d
  compose  — head composite + 5-cell green sheet → sheet-original.png
  import   — import-avatar-sheet.py
  lint     — art_lint.py (structure anchors + base-palette contrast)

Does NOT upload to R2 (that stays upload-asset-originals.py — the operator
reviews the sheet first). Records a yield line into docs/factory-yield.md
when --record-yield is set.

Usage:
    CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... \\
    python3 scripts/factory/run_avatar.py path/to/order.json [--stage stand|walk|...]
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))

from factory import templates  # noqa: E402
from factory.art_lint import lint_avatar  # noqa: E402
from factory.compose_sheet import compose_walk_sheet  # noqa: E402
from factory.foot_phase import select_walk_paths  # noqa: E402

ASSET_ROOT = ROOT / "packages/client/src/game.package"
BASE_MANIFEST = ASSET_ROOT / "avatar" / "manifest.json"
GENERATE = SCRIPTS / "generate-via-ai-gateway.py"
IMPORT = SCRIPTS / "import-avatar-sheet.py"


def run(cmd: list[str], **kwargs) -> subprocess.CompletedProcess:
    print("+", " ".join(cmd), flush=True)
    return subprocess.run(cmd, check=True, **kwargs)


def expand_prompt(order: dict) -> str:
    if order.get("template"):
        return templates.expand(order["template"], order.get("vars") or {})
    if order.get("prompt"):
        return order["prompt"]
    raise SystemExit("order needs `template`+`vars` or `prompt`")


def generate_image(prompt: str, images: list[Path], out_prefix: Path, field: str) -> Path:
    cmd = [
        sys.executable,
        str(GENERATE),
        "--model",
        "google/nano-banana-2",
        "--prompt",
        prompt,
        "--field",
        field,
        "--out",
        str(out_prefix),
    ]
    for img in images:
        cmd += ["--image", str(img)]
    result = run(cmd, capture_output=True, text=True)
    print(result.stderr, file=sys.stderr)
    paths = [ln.strip() for ln in result.stdout.splitlines() if ln.strip().endswith(".png")]
    if not paths:
        raise SystemExit(f"no png from generator:\n{result.stdout}\n{result.stderr}")
    return Path(paths[0])


def generate_video(prompt: str, image: Path, out_prefix: Path) -> Path:
    cmd = [
        sys.executable,
        str(GENERATE),
        "--model",
        "alibaba/wan-2.7-i2v",
        "--prompt",
        prompt,
        "--field",
        "image",
        "--image",
        str(image),
        "--out",
        str(out_prefix),
    ]
    result = run(cmd, capture_output=True, text=True)
    print(result.stderr, file=sys.stderr)
    paths = [ln.strip() for ln in result.stdout.splitlines() if ln.strip().endswith(".mp4")]
    if not paths:
        raise SystemExit(f"no mp4 from generator:\n{result.stdout}\n{result.stderr}")
    return Path(paths[0])


def extract_frames(video: Path, out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    for old in out_dir.glob("frame_*.png"):
        old.unlink()
    run(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(video),
            "-vsync",
            "0",
            str(out_dir / "frame_%04d.png"),
        ],
        capture_output=True,
    )


def prepare_stand_canvas(stand_src: Path, canvas_path: Path, size: int = 720) -> None:
    """Center the stand on a pure green square with feet near y=640 (bench recipe)."""
    from PIL import Image

    src = Image.open(stand_src).convert("RGBA")
    canvas = Image.new("RGBA", (size, size), (0, 255, 0, 255))
    # Scale so character height ≈ 470px (bench).
    target_h = 470
    scale = target_h / src.height
    resized = src.resize(
        (max(1, round(src.width * scale)), max(1, round(src.height * scale))),
        Image.LANCZOS,
    )
    x = (size - resized.width) // 2
    y = 640 - resized.height
    # Clear greenish pixels to transparent before paste.
    px = resized.load()
    for yy in range(resized.height):
        for xx in range(resized.width):
            r, g, b, a = px[xx, yy]
            if g - max(r, b) >= 40:
                px[xx, yy] = (0, 0, 0, 0)
    canvas.paste(resized, (x, max(0, y)), resized)
    canvas.convert("RGB").save(canvas_path)


def append_yield(row: dict) -> None:
    path = ROOT / "docs/factory-yield.md"
    if not path.exists():
        path.write_text(
            "# ファクトリー歩留まり記録（①b / DP-B 材料）\n\n"
            "| 日付 | キャラ | 動画本数 | 静止画枚数 | コスト概算 | 所要 | 成否 | メモ |\n"
            "| --- | --- | --- | --- | --- | --- | --- | --- |\n"
        )
    line = (
        f"| {row['date']} | {row['id']} | {row['videos']} | {row['stills']} | "
        f"${row['cost']:.2f} | {row['minutes']:.0f}m | {row['ok']} | {row['note']} |\n"
    )
    path.write_text(path.read_text() + line)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("order", type=Path)
    parser.add_argument(
        "--work",
        type=Path,
        default=None,
        help="scratch dir (default: /tmp/kaede-factory/<order-id>)",
    )
    parser.add_argument(
        "--from-stage",
        default="stand",
        choices=["stand", "walk", "extract", "select", "compose", "import", "lint"],
    )
    parser.add_argument(
        "--upto",
        default="lint",
        choices=["stand", "walk", "extract", "select", "compose", "import", "lint"],
    )
    parser.add_argument("--record-yield", action="store_true")
    parser.add_argument("--walk-prompt-template", default="avatar-walk-i2v")
    args = parser.parse_args()

    order_path = args.order.resolve()
    order = json.loads(order_path.read_text())
    work = args.work or Path(f"/tmp/kaede-factory/{order['id']}")
    work.mkdir(parents=True, exist_ok=True)

    stages = ["stand", "walk", "extract", "select", "compose", "import", "lint"]
    start_i, end_i = stages.index(args.from_stage), stages.index(args.upto)
    active = set(stages[start_i : end_i + 1])

    t0 = time.time()
    videos = stills = 0
    cost = 0.0
    note_parts: list[str] = []

    # Resolve references (canonical style refs preferred).
    base = order_path.parent
    refs = [base / r for r in order.get("references", [])]
    canonical = ASSET_ROOT / "canonical" / "style-reference.png"
    if canonical.is_file() and canonical not in refs:
        refs = [canonical, *refs]

    stand_prompt = expand_prompt(order)
    # Persist expanded prompt into the order for reproducibility when templated.
    if order.get("template") and order.get("prompt") != stand_prompt:
        order["prompt"] = (
            f"Factory template `{order['template']}` expanded "
            f"({time.strftime('%Y-%m-%d')}): {stand_prompt}"
        )
        order_path.write_text(json.dumps(order, ensure_ascii=False, indent=2) + "\n")

    stand_raw = work / "stand_raw.png"
    stand_canvas = work / "stand_canvas.png"
    if "stand" in active:
        if not os.environ.get("CLOUDFLARE_API_TOKEN"):
            raise SystemExit("CLOUDFLARE_API_TOKEN required for generation")
        out = generate_image(stand_prompt, refs[:2], work / "stand", "image_input")
        shutil.copy(out, stand_raw)
        stills += 1
        cost += 0.10
        note_parts.append("stand:nano")
    elif stand_raw.exists():
        pass
    elif (base / "stand-seed.png").is_file():
        shutil.copy(base / "stand-seed.png", stand_raw)
    else:
        raise SystemExit(f"no stand at {stand_raw} — run with --from-stage stand")

    prepare_stand_canvas(stand_raw, stand_canvas)

    video_path = work / "walk.mp4"
    if "walk" in active:
        walk_prompt = templates.expand(args.walk_prompt_template, {})
        src = generate_video(walk_prompt, stand_canvas, work / "walk")
        shutil.copy(src, video_path)
        videos += 1
        cost += 0.50
        note_parts.append("walk:wan")

    frames_dir = work / "frames"
    if "extract" in active:
        if not video_path.is_file():
            raise SystemExit(f"missing {video_path}")
        extract_frames(video_path, frames_dir)

    walk_map_path = work / "walk_selection.json"
    if "select" in active:
        selected = select_walk_paths(frames_dir)
        walk_map_path.write_text(
            json.dumps({k: str(v) for k, v in selected.items()}, indent=2) + "\n"
        )
        print("selected", {k: v.name for k, v in selected.items()})
    else:
        selected = {k: Path(v) for k, v in json.loads(walk_map_path.read_text()).items()}

    sheet_path = base / order["sheet"]
    if "compose" in active:
        necks = compose_walk_sheet(stand_raw, selected, sheet_path)
        # Seed neckAnchors from structure detection so import doesn't rely on
        # the broken narrowest-row heuristic for new outfits.
        order["neckAnchors"] = {
            pose: list(neck) for pose, neck in necks.items()
        }
        # neckAnchors above are in compose-trim space; import re-detects after
        # its own scale. Drop them — import uses structure_neck via the patched
        # importer when no override is set. Keep the sheet only.
        order.pop("neckAnchors", None)
        order_path.write_text(json.dumps(order, ensure_ascii=False, indent=2) + "\n")
        print(f"wrote {sheet_path}")

    if "import" in active:
        run([sys.executable, str(IMPORT), str(order_path)])

    if "lint" in active:
        manifest_path = (base / order.get("outDir", ".")).resolve() / "manifest.json"
        # Palette-vs-base-outfit contrast is opt-in per order (held items and
        # high-risk light clothes set lint.contrastBase). Body sheets share
        # skin tones with the base by design, so contrast is not a hard gate
        # unless requested.
        contrast = (order.get("lint") or {}).get("contrastBase")
        palette = None
        if contrast:
            palette = json.loads((ASSET_ROOT / contrast).read_text()).get("palette")
        failures = lint_avatar(
            manifest_path,
            base_palette=palette,
            expect_carry_hand=bool(order.get("handLayer")),
        )
        if failures:
            print("ART LINT FAIL", file=sys.stderr)
            for f in failures:
                print(f"  - {f}", file=sys.stderr)
            if args.record_yield:
                append_yield(
                    {
                        "date": time.strftime("%Y-%m-%d"),
                        "id": order["id"],
                        "videos": videos,
                        "stills": stills,
                        "cost": cost,
                        "minutes": (time.time() - t0) / 60,
                        "ok": "FAIL lint",
                        "note": "; ".join(note_parts + failures[:2]),
                    }
                )
            raise SystemExit(1)
        print("ART LINT PASS")

    minutes = (time.time() - t0) / 60
    print(f"done {order['id']} in {minutes:.1f}m approx_cost=${cost:.2f}")
    if args.record_yield:
        append_yield(
            {
                "date": time.strftime("%Y-%m-%d"),
                "id": order["id"],
                "videos": videos,
                "stills": stills,
                "cost": cost,
                "minutes": minutes,
                "ok": "PASS",
                "note": "; ".join(note_parts) or "resume",
            }
        )


if __name__ == "__main__":
    main()
