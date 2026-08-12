#!/usr/bin/env python3
"""Drive one avatar order through the connected factory line (①b).

Two lanes, picked by the order's template:

VIDEO lane (new characters — template `avatar-stand`):
  stand    — nano-banana-2 stand frame (canonical references attached)
  walk     — wan-2.7-i2v walk clip from the stand (exaggerated-swing recipe)
  extract  — ffmpeg frames from the walk mp4
  select   — foot-phase auto selection of walk-a..d (足位置解析)
  compose  — head composite (erase-then-paste) + 5-cell green sheet
  import   — import-avatar-sheet.py
  lint     — art_lint.py (structure anchors, head consistency, palette
             drift, optional base-palette contrast)

SHEET-EDIT lane (outfit swaps — template `avatar-outfit-edit`, the
①b(a)⑵ keep-everything recipe; no video, poses preserved by construction):
  edit     — nano-banana-2 edit of an existing composed sheet (editSource)
  import   — import-avatar-sheet.py
  lint     — art_lint.py + per-pose silhouette IoU against the source
             asset's committed frames (pose-fidelity gate)

Both lanes finish by writing a review montage (work dir) for the visual
gate. Does NOT upload to R2 (that stays upload-asset-originals.py — the
operator reviews the sheet first). Records a yield line into
docs/factory-yield.md when --record-yield is set.

Usage:
    CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... \\
    python3 scripts/factory/run_avatar.py path/to/order.json
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))

from factory import templates  # noqa: E402
from factory.art_lint import lint_avatar, silhouette_iou  # noqa: E402
from factory.compose_sheet import compose_walk_sheet, staticize_carry_sheet  # noqa: E402
from factory.cycle_scan import scan_clip  # noqa: E402
from factory.montage import sheet_montage  # noqa: E402
from factory.video import extract_frames  # noqa: E402
from r2_originals import (  # noqa: E402
    resolve_asset_path,
    resolve_original,
    validate_order_path,
)

# A keep-everything outfit edit keeps poses: the red hoodie measured IoU
# 0.916–0.956 per pose; bare-skin edits shed sleeve/pant silhouette and sit
# lower. A regression to one stride drops a contact frame far below this.
SHEET_EDIT_IOU_MIN = 0.80

ASSET_ROOT = ROOT / "packages/client/src/game.package"
BASE_MANIFEST = ASSET_ROOT / "avatar" / "manifest.json"
GENERATE = SCRIPTS / "generate-via-ai-gateway.py"
IMPORT = SCRIPTS / "import-avatar-sheet.py"
# Order ids are lowercase dotted slugs (asset-pipeline.md §2). The default
# scratch path joins this under SCRATCH_ROOT; rejecting non-slugs stops a
# crafted `../` id from escaping /tmp/kaede-factory.
ID_PATTERN = re.compile(r"[a-z0-9][a-z0-9.-]*\Z")
SCRATCH_ROOT = Path("/tmp/kaede-factory").resolve()


def resolve_scratch_dir(order_id: str, work: Path | None) -> Path:
    """Default scratch under /tmp/kaede-factory/<id>; reject escaping ids."""
    if work is not None:
        return work.resolve()
    if ID_PATTERN.fullmatch(order_id) is None:
        raise SystemExit(f"invalid order id for scratch dir: {order_id!r}")
    scratch = (SCRATCH_ROOT / order_id).resolve()
    try:
        scratch.relative_to(SCRATCH_ROOT)
    except ValueError as error:
        raise SystemExit(
            f"scratch dir escapes {SCRATCH_ROOT}: {order_id!r}"
        ) from error
    return scratch


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


def manifest_path_of(order_path: Path, order: dict) -> Path:
    return (order_path.parent / order.get("outDir", ".")).resolve() / "manifest.json"


def run_lint(order_path: Path, order: dict) -> list[str]:
    """art_lint over the imported manifest, honoring the order's lint options."""
    # Palette-vs-base-outfit contrast is opt-in per order (held items and
    # high-risk light clothes set lint.contrastBase). Body sheets share
    # skin tones with the base by design, so contrast is not a hard gate
    # unless requested.
    lint_options = order.get("lint") or {}
    contrast = lint_options.get("contrastBase")
    palette = None
    if contrast:
        palette = json.loads((ASSET_ROOT / contrast).read_text()).get("palette")
    failures = lint_avatar(
        manifest_path_of(order_path, order),
        base_palette=palette,
        expect_carry_hand=bool(order.get("handLayer")),
        # Carry sheets stride gently by spec; every other walk cycle must
        # show opposite-leg contacts and a real second passing.
        expect_leg_phase=not order.get("handLayer"),
    )
    # Variant sheets (carry) must keep their paired outfit's colors: the
    # try-on stage swaps outfit ⇄ carry when an item is picked up, so a
    # skin/garment tone jump between the pair is a visible defect (measured
    # on a pants-carry retake that came back paler than boy-pants).
    match_stand = lint_options.get("matchStand")
    if match_stand:
        from PIL import Image

        from factory.art_lint import check_palette_drift

        paired = json.loads((ASSET_ROOT / match_stand).read_text())
        paired_stand = Image.open(
            (ASSET_ROOT / match_stand).parent / paired["poses"]["stand"]["file"]
        ).convert("RGBA")
        manifest = json.loads(manifest_path_of(order_path, order).read_text())
        own_stand = Image.open(
            manifest_path_of(order_path, order).parent
            / manifest["poses"]["stand"]["file"]
        ).convert("RGBA")
        failures += [
            f"stand vs {match_stand}: {f}"
            for f in check_palette_drift(paired_stand, own_stand)
        ]
    return failures


def sheet_edit_iou_failures(order_path: Path, order: dict) -> list[str]:
    """Pose-fidelity gate: imported frames vs the edit-source asset's frames."""
    from PIL import Image

    base = order_path.parent
    source_dir = (base / order["editSource"]).resolve().parent
    source_manifest = json.loads((source_dir / "manifest.json").read_text())
    # Imported frames live next to the manifest (outDir), not the order.
    manifest_path = manifest_path_of(order_path, order)
    out_dir = manifest_path.parent
    manifest = json.loads(manifest_path.read_text())
    failures: list[str] = []
    for pose, meta in manifest.get("poses", {}).items():
        source_meta = source_manifest.get("poses", {}).get(pose)
        if source_meta is None:
            failures.append(f"{pose}: edit source has no such pose")
            continue
        edited = Image.open(out_dir / meta["file"]).convert("RGBA")
        source = Image.open(source_dir / source_meta["file"]).convert("RGBA")
        iou = silhouette_iou(edited, source)
        print(f"IoU {pose}: {iou:.3f} (vs {source_dir.name})")
        if iou < SHEET_EDIT_IOU_MIN:
            failures.append(
                f"{pose}: silhouette IoU {iou:.3f} < {SHEET_EDIT_IOU_MIN} vs "
                f"the edit source — the edit drifted the pose"
            )
    return failures


def run_sheet_edit_lane(order_path: Path, order: dict, work: Path, args) -> None:
    """The keep-everything outfit-edit lane (no video; poses preserved)."""
    base = order_path.parent
    t0 = time.time()
    stills = 0
    cost = 0.0

    prompt = expand_prompt(order)
    generates = args.from_stage in ("stand", "walk", "extract", "select", "compose")
    recorded = (
        f"Factory template `{order['template']}` over "
        f"{order['editSource']} ({time.strftime('%Y-%m-%d')}): {prompt}"
    )
    # Persist only on generating runs — an import/lint resume must not
    # clobber a hand-curated provenance record (video-lane rule).
    if generates and order.get("template") and order.get("prompt") != recorded:
        order["prompt"] = recorded
        order_path.write_text(json.dumps(order, ensure_ascii=False, indent=2) + "\n")
        subprocess.run(
            ["pnpm", "exec", "biome", "format", "--write", str(order_path)],
            check=True,
        )

    sheet_path = resolve_asset_path(base, order["sheet"], ASSET_ROOT)
    if generates:
        if not os.environ.get("CLOUDFLARE_API_TOKEN"):
            raise SystemExit("CLOUDFLARE_API_TOKEN required for generation")
        source = resolve_original(
            base, order["editSource"], order.get("originals", {}), ASSET_ROOT
        )
        out = generate_image(prompt, [source], work / "edit", "image_input")
        shutil.copy(out, sheet_path)
        stills += 1
        cost += 0.10
        print(f"wrote {sheet_path}")
        if order.get("handLayer"):
            # Carry sheets are upper-body-static by spec; make that literal
            # so the belly shading cannot flicker between cells.
            seam = staticize_carry_sheet(sheet_path)
            print(f"carry staticize: upper body unified above row {seam}")
    elif not sheet_path.is_file():
        raise SystemExit(f"no sheet at {sheet_path} — run without --from-stage import")

    run([sys.executable, str(IMPORT), str(order_path)])

    failures = run_lint(order_path, order) + sheet_edit_iou_failures(order_path, order)
    ok = "PASS" if not failures else "FAIL lint"
    if failures:
        print("ART LINT FAIL", file=sys.stderr)
        for f in failures:
            print(f"  - {f}", file=sys.stderr)
    else:
        print("ART LINT PASS")
        montage = work / "montage.png"
        sheet_montage(manifest_path_of(order_path, order), montage)
        print(f"review montage: {montage}")

    minutes = (time.time() - t0) / 60
    print(f"done {order['id']} in {minutes:.1f}m approx_cost=${cost:.2f}")
    if args.record_yield:
        append_yield(
            {
                "date": time.strftime("%Y-%m-%d"),
                "id": order["id"],
                "videos": 0,
                "stills": stills,
                "cost": cost,
                "minutes": minutes,
                "ok": ok,
                "note": "; ".join(["sheet-edit:nano"] + failures[:2]),
            }
        )
    if failures:
        raise SystemExit(1)


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
    parser.add_argument(
        "--walk-prompt-template",
        default=None,
        help="override the walk template (default: the order's `walkTemplate`, "
        "then avatar-walk-i2v); the choice is persisted into the order",
    )
    parser.add_argument(
        "--contact",
        type=int,
        default=None,
        help="pin the cycle scan to one contact frame index (visual-gate "
        "override — e.g. the stride whose arm swing reads best)",
    )
    args = parser.parse_args()

    # Same gate as import-avatar-sheet.py: order.json must live under the
    # asset root before we read it or later rewrite provenance into it.
    order_path = validate_order_path(args.order, ASSET_ROOT)
    order = json.loads(order_path.read_text())
    work = resolve_scratch_dir(order["id"], args.work)
    work.mkdir(parents=True, exist_ok=True)

    if order.get("template") == "avatar-outfit-edit":
        run_sheet_edit_lane(order_path, order, work, args)
        return

    stages = ["stand", "walk", "extract", "select", "compose", "import", "lint"]
    start_i, end_i = stages.index(args.from_stage), stages.index(args.upto)
    active = set(stages[start_i : end_i + 1])

    t0 = time.time()
    videos = stills = 0
    cost = 0.0
    note_parts: list[str] = []

    # Resolve references (canonical style refs preferred). resolve_asset_path
    # rejects absolute paths and root escapes (a crafted order must not be
    # able to read arbitrary local files into an external API call — security
    # review 2026-08-10) and returns canonical paths, so the dedup below
    # actually fires when an order already lists the canonical reference
    # (raw `base / r` never equalled the absolute canonical path, silently
    # dropping the order's second reference from the [:2] send window).
    base = order_path.parent
    refs = [
        resolve_asset_path(base, r, ASSET_ROOT)
        for r in order.get("references", [])
    ]
    canonical = (ASSET_ROOT / "canonical" / "style-reference.png").resolve()
    if canonical.is_file() and canonical not in refs:
        refs = [canonical, *refs]

    stand_prompt = expand_prompt(order)
    # The walk template is part of the recipe (color-locked characters need
    # avatar-walk-i2v-locked), so the order's `walkTemplate` wins over the
    # generic default and any choice is persisted back for reproducibility.
    walk_template = (
        args.walk_prompt_template or order.get("walkTemplate") or "avatar-walk-i2v"
    )
    walk_prompt = templates.expand(walk_template, order.get("vars") or {})
    # Persist the full expanded recipe into the order for reproducibility —
    # but only when this run actually GENERATES with it. Resumes (select /
    # import / lint) must not clobber a hand-curated provenance record (the
    # girl's order narrates the adopted take and frame selection; a lint-only
    # rerun once overwrote it with the template expansion).
    generates = bool(active & {"stand", "walk"})
    recorded = (
        f"Factory template `{order['template']}` expanded "
        f"({time.strftime('%Y-%m-%d')}): {stand_prompt} | walk template "
        f"`{walk_template}`: {walk_prompt}"
    ) if generates and order.get("template") else None
    if recorded is not None and (
        order.get("prompt") != recorded
        or order.get("walkTemplate") != walk_template
    ):
        order["prompt"] = recorded
        order["walkTemplate"] = walk_template
        order_path.write_text(json.dumps(order, ensure_ascii=False, indent=2) + "\n")
        subprocess.run(
            ["pnpm", "exec", "biome", "format", "--write", str(order_path)],
            check=True,
        )

    stand_raw = work / "stand_raw.png"
    stand_canvas = work / "stand_canvas.png"
    # Only walk (canvas) and compose (head source) consume the stand; a
    # resume from import/lint must not demand generation artifacts.
    # select composes candidate cycles for its checks, so it needs the stand.
    needs_stand = bool(active & {"stand", "walk", "select", "compose"})
    if "stand" in active:
        if not os.environ.get("CLOUDFLARE_API_TOKEN"):
            raise SystemExit("CLOUDFLARE_API_TOKEN required for generation")
        out = generate_image(stand_prompt, refs[:2], work / "stand", "image_input")
        shutil.copy(out, stand_raw)
        stills += 1
        cost += 0.10
        note_parts.append("stand:nano")
    elif not needs_stand or stand_raw.exists():
        pass
    elif (base / "stand-seed.png").is_file():
        shutil.copy(base / "stand-seed.png", stand_raw)
    else:
        raise SystemExit(f"no stand at {stand_raw} — run with --from-stage stand")

    if needs_stand:
        prepare_stand_canvas(stand_raw, stand_canvas)

    video_path = work / "walk.mp4"
    if "walk" in active:
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
        # Drift-aware scan over the whole clip (cycle_scan.py): every stride
        # is a candidate cycle and failing slots try phase-equivalent
        # substitutes, so one clean cycle anywhere in the clip suffices.
        selected = scan_clip(
            stand_raw, frames_dir, pinned_contact=args.contact
        )
        walk_map_path.write_text(
            json.dumps(
                {k: [str(p) for p in v] for k, v in selected.items()}, indent=2
            )
            + "\n"
        )
        print("selected", {k: v[0].name for k, v in selected.items()})
    elif "compose" in active:
        # Only compose consumes the selection; a resume from import/lint
        # must not demand this artifact of an earlier select run.
        selected = {
            k: [Path(p) for p in v]
            for k, v in json.loads(walk_map_path.read_text()).items()
        }

    sheet_path = resolve_asset_path(base, order["sheet"], ASSET_ROOT)
    if "compose" in active:
        # Import re-detects anchors on the final frames (structure_neck),
        # so compose only needs to write the sheet.
        compose_walk_sheet(stand_raw, selected, sheet_path)
        print(f"wrote {sheet_path}")

    if "import" in active:
        run([sys.executable, str(IMPORT), str(order_path)])

    if "lint" in active:
        failures = run_lint(order_path, order)
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
        montage = work / "montage.png"
        sheet_montage(manifest_path_of(order_path, order), montage)
        print(f"review montage: {montage}")

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
