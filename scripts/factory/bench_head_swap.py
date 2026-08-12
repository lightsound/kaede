#!/usr/bin/env python3
"""①d head-swap bench (Phase 5 — 頭グループ分離+髪・顔の着せ替えの最小ベンチ).

Answers the ①d round-1 question with one-take $0.10 nano edits: can a hair
(or face/expression) variant be produced as ONE head-group image and
composited onto the COMMITTED body cells at their manifest neck anchors,
style-faithfully, without regenerating a single body pose? That is the core
claim of the head-group layer (avatar-rig.md §2): if it holds, hair N 種 =
画像 N 枚 whatever the pose count.

Recipe (the ①c bench's reference+instruction method):
1. `prepare` places a committed stand cell on the 720px green canvas —
   the exact geometry every ①c nano edit used (extract_headgear shares it).
2. Generate a keep-everything edit that changes ONLY the hair (or face)
   with scripts/generate-via-ai-gateway.py (nano-banana-2, ~$0.10/枚).
3. `composite` extracts the HEAD GROUP from the edit and erase-then-pastes
   it onto committed cells at their manifest neck anchors, then writes a
   base-vs-swapped montage and a walk-cycle clip for review.

The head-group extraction (the ①d shape of the walk-import machinery):
ABOVE the neck line the whole edit content is taken (full head
replacement, the paste_head rule); BELOW it only the pixels that DIFFER
from the base stand canvas are kept (the extract_headgear diff — long
hair hanging past the neck, and nothing else, because the keep-everything
prompt keeps the body pixel-identical). The neck needs no structural
detection on the edit at all: the body underneath is unchanged by
construction, so the base stand's manifest neck (a measured value)
transfers — which also sidesteps the hoodie-class detector failure long
hair causes (measured on the twin-tails take, this bench).

Poses are composited on request, INCLUDING the ones expected to break:
wave's raised arm and the dance cells cross the neck line, so
erase-then-paste eats the arm (measured in the ①c bench, factory-yield
2026-08-10). Their breakage in the montage is design evidence for the ①d
pose classification (head-swappable vs video-native-head), not a bench bug.
Below-neck hair pastes OVER the body — the front-hair z; a behind-body
back-hair layer is a design question the bench records, not solves.

Usage:
    python3 scripts/factory/bench_head_swap.py prepare \
        --skin avatar --out /tmp/bench-1d/stand-canvas.png
    CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... \
    python3 scripts/generate-via-ai-gateway.py \
        --model google/nano-banana-2 --field image_input \
        --image /tmp/bench-1d/stand-canvas.png --prompt "..." \
        --out /tmp/bench-1d/hair-take
    python3 scripts/factory/bench_head_swap.py composite \
        --edit /tmp/bench-1d/hair-take_0.png --skin avatar \
        --poses stand,walk-a,walk-b,walk-c,walk-d,sit,wave,dance-a \
        --out /tmp/bench-1d/hair
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

from factory.compose_sheet import CHIN_OVERLAP, chroma_key  # noqa: E402
from factory.extract_headgear import (  # noqa: E402
    CANVAS_CHAR_H,
    CANVAS_GROUND_Y,
    DIFF_MIN,
    canvas_of_stand,
)

ASSET_ROOT = ROOT / "packages/client/src/game.package"
# Nano returns 1024²; every ①c measurement was made after scaling back to
# the 720 canvas (the compose_gesture_sheet rule).
CANVAS = 720
# Review artifacts upscale NEAREST like montage.py (pixel look).
MONTAGE_SCALE = 3
MONTAGE_PADDING = 10
MONTAGE_BACKGROUND = (240, 240, 245)
WALK_FRAME_MS = 200  # STRIDE_PX / MOVE_SPEED per frame — rig.ts cadence


def load_manifest(skin: str) -> tuple[dict, Path]:
    path = ASSET_ROOT / skin / "manifest.json"
    return json.loads(path.read_text()), path.parent


def committed_cells(skins: list[str]) -> dict[str, tuple[Image.Image, tuple[int, int]]]:
    """pose -> (cell image, neck anchor) across the given manifests; the
    first manifest wins shared poses (the loadGestureKit stand rule)."""
    cells: dict[str, tuple[Image.Image, tuple[int, int]]] = {}
    for skin in skins:
        manifest, base = load_manifest(skin)
        for pose, meta in manifest["poses"].items():
            if pose in cells:
                continue
            neck = meta["anchors"].get("neck")
            if neck is None:
                continue
            cells[pose] = (Image.open(base / meta["file"]).convert("RGBA"), tuple(neck))
    return cells


def prepare(skin: str, out: Path) -> None:
    stand = Image.open(ASSET_ROOT / skin / "stand.png").convert("RGBA")
    canvas, _ = canvas_of_stand(stand)
    out.parent.mkdir(parents=True, exist_ok=True)
    canvas.convert("RGB").save(out)
    print(f"wrote {out} ({canvas.width}x{canvas.height})")


def head_group_of_edit(
    edit_path: Path, base_stand: Image.Image, base_neck: tuple[int, int]
) -> tuple[Image.Image, tuple[int, int]]:
    """(head-group crop, its neck point) extracted from the edit, at the
    720-canvas scale.

    The base stand cell and its manifest neck locate the neck ON THE
    CANVAS (the keep-everything invariant: the edited body is
    pixel-identical, so the base's measured neck transfers). Above the
    neck line (+CHIN_OVERLAP, scaled) everything opaque is head group;
    below it, only pixels differing from the base canvas (long hair)."""
    base_canvas, (off_x, off_y) = canvas_of_stand(base_stand)
    canvas_scale = CANVAS_CHAR_H / base_stand.height
    neck_canvas = (
        off_x + round(base_neck[0] * canvas_scale),
        CANVAS_GROUND_Y - round((base_stand.height - base_neck[1]) * canvas_scale),
    )
    # CHIN_OVERLAP is calibrated for compose_sheet's 400px working height.
    cut_y = neck_canvas[1] + round(CHIN_OVERLAP * CANVAS_CHAR_H / 400)

    edit = Image.open(edit_path).convert("RGBA")
    if edit.size != (CANVAS, CANVAS):
        edit = edit.resize((CANVAS, CANVAS), Image.LANCZOS)
    keyed = np.asarray(chroma_key(edit))
    opaque = keyed[:, :, 3] >= 128
    a = np.asarray(base_canvas.convert("RGB")).astype(int)
    b = np.asarray(edit.convert("RGB")).astype(int)
    differs = np.sqrt(((a - b) ** 2).sum(axis=2)) > DIFF_MIN
    rows = np.arange(CANVAS)[:, None]
    mask = opaque & ((rows < cut_y) | differs)

    out = np.zeros((CANVAS, CANVAS, 4), np.uint8)
    out[mask] = keyed[mask]
    ys, xs = np.where(mask)
    if len(ys) == 0:
        raise SystemExit("no head-group pixels found in the edit")
    x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
    crop = Image.fromarray(out[y0:y1, x0:x1], "RGBA")
    return crop, (neck_canvas[0] - int(x0), neck_canvas[1] - int(y0))


def scaled_head_group(
    edit_path: Path,
    base_stand: Image.Image,
    base_neck: tuple[int, int],
) -> tuple[Image.Image, tuple[int, int]]:
    """The head group scaled from canvas to committed-cell pixels."""
    crop, neck = head_group_of_edit(edit_path, base_stand, base_neck)
    scale = base_stand.height / CANVAS_CHAR_H
    resized = crop.resize(
        (max(1, round(crop.width * scale)), max(1, round(crop.height * scale))),
        Image.LANCZOS,
    )
    return resized, (round(neck[0] * scale), round(neck[1] * scale))


# A component above the neck row is the OLD HEAD if it reaches up past
# this fraction of the neck height; body parts that merely poke above the
# row (a leaning stride's shoulder line rises a few px) stay well below it.
HEAD_REACH_FRAC = 0.6


def erase_old_head(body: Image.Image, neck_y: int) -> Image.Image:
    """Erase the old head above the neck row, KEEPING body pixels there.

    paste_head erases the full rows above the neck, which is safe at the
    import line's 400px working height but opened a 1-2px neck gap at cell
    scale on the girl's walk-c (owner-reported): the forward-leaning
    stride's shoulder line rises above the neck row, the full-row erase
    ate it, and the head group's chin overlap (~3px after downscale) could
    not reach it. Component erase fixes it: only the connected component(s)
    that reach the head zone (HEAD_REACH_FRAC) are the old head; shoulder
    bumps stay. Measured caveat, deliberate: hair hanging BELOW the neck
    row (the girl's bob tips) is not erased — the ①d factory's headless
    variants need the full head diff, a design-doc point, and the bench
    takes cover it with larger replacement hair."""
    import numpy as np
    from scipy import ndimage

    rgba = np.asarray(body.convert("RGBA")).copy()
    above = rgba[:neck_y, :, 3] > 0
    labels, count = ndimage.label(above)
    if count:
        erase = np.zeros_like(above)
        for i, bounds in enumerate(ndimage.find_objects(labels)):
            if bounds is not None and bounds[0].start < neck_y * HEAD_REACH_FRAC:
                erase |= labels == i + 1
        rgba[:neck_y][erase] = 0
    return Image.fromarray(rgba)


def paste_head_group(
    body: Image.Image, group: Image.Image, group_neck: tuple[int, int], body_neck: tuple[int, int]
) -> Image.Image:
    """paste_head's erase-then-paste, with two cell-scale differences:
    aligned on the NECK POINT (not the crop's horizontal center — a
    long-hair crop is asymmetric) and erasing by old-head component
    (erase_old_head), not by full rows."""
    paste_x = body_neck[0] - group_neck[0]
    paste_y = body_neck[1] - group_neck[1]
    out = erase_old_head(body, body_neck[1]) if body_neck[1] > 0 else body.copy()
    pad_left = max(0, -paste_x)
    pad_top = max(0, -paste_y)
    pad_right = max(0, paste_x + group.width - out.width)
    pad_bottom = max(0, paste_y + group.height - out.height)
    if pad_left or pad_top or pad_right or pad_bottom:
        canvas = Image.new(
            "RGBA",
            (out.width + pad_left + pad_right, out.height + pad_top + pad_bottom),
            (0, 0, 0, 0),
        )
        canvas.paste(out, (pad_left, pad_top), out)
        out = canvas
        paste_x += pad_left
        paste_y += pad_top
    out.paste(group, (paste_x, paste_y), group)
    return out


def montage(rows: list[list[Image.Image]], out_path: Path) -> None:
    cell_w = max(f.width for row in rows for f in row) + MONTAGE_PADDING
    cell_h = max(f.height for row in rows for f in row) + MONTAGE_PADDING
    columns = max(len(row) for row in rows)
    canvas = Image.new(
        "RGB",
        (cell_w * columns * MONTAGE_SCALE, cell_h * len(rows) * MONTAGE_SCALE),
        MONTAGE_BACKGROUND,
    )
    for row_i, row in enumerate(rows):
        for col_i, frame in enumerate(row):
            big = frame.resize(
                (frame.width * MONTAGE_SCALE, frame.height * MONTAGE_SCALE),
                Image.NEAREST,
            )
            x = col_i * cell_w * MONTAGE_SCALE + (cell_w * MONTAGE_SCALE - big.width) // 2
            y = row_i * cell_h * MONTAGE_SCALE + (cell_h * MONTAGE_SCALE - big.height)
            canvas.paste(big, (x, y), big)
    canvas.save(out_path)
    print(f"wrote {out_path}")


def walk_clip(frames: list[Image.Image], out_dir: Path, name: str) -> None:
    """The swapped walk cycle as an mp4 (ffmpeg), the review evidence."""
    clip_dir = out_dir / f"{name}-frames"
    clip_dir.mkdir(parents=True, exist_ok=True)
    w = max(f.width for f in frames) * MONTAGE_SCALE
    h = max(f.height for f in frames) * MONTAGE_SCALE
    w, h = w + w % 2, h + h % 2
    loops = 5  # ~4s of cycle at WALK_FRAME_MS
    for i in range(len(frames) * loops):
        frame = frames[i % len(frames)]
        big = frame.resize(
            (frame.width * MONTAGE_SCALE, frame.height * MONTAGE_SCALE), Image.NEAREST
        )
        cell = Image.new("RGB", (w, h), MONTAGE_BACKGROUND)
        cell.paste(big, ((w - big.width) // 2, h - big.height), big)
        cell.save(clip_dir / f"{i:03}.png")
    subprocess.run(
        [
            "ffmpeg", "-y", "-loglevel", "error",
            "-framerate", str(1000 / WALK_FRAME_MS),
            "-i", str(clip_dir / "%03d.png"),
            "-pix_fmt", "yuv420p",
            str(out_dir / f"{name}.mp4"),
        ],
        check=True,
        input=b"",
    )
    print(f"wrote {out_dir / f'{name}.mp4'}")


def composite(edit: Path, skins: list[str], poses: list[str], out_dir: Path) -> None:
    cells = committed_cells(skins)
    manifest, base_dir = load_manifest(skins[0])
    stand_meta = manifest["poses"]["stand"]
    base_stand = Image.open(base_dir / stand_meta["file"]).convert("RGBA")
    base_neck = tuple(stand_meta["anchors"]["neck"])
    group, group_neck = scaled_head_group(edit, base_stand, base_neck)
    out_dir.mkdir(parents=True, exist_ok=True)
    base_row: list[Image.Image] = []
    swap_row: list[Image.Image] = []
    for pose in poses:
        if pose not in cells:
            raise SystemExit(f"pose {pose!r} not in manifests of {skins}")
        body, neck = cells[pose]
        swapped = paste_head_group(body, group, group_neck, neck)
        swapped.save(out_dir / f"{pose}.png")
        base_row.append(body)
        swap_row.append(swapped)
    montage([base_row, swap_row], out_dir / "montage.png")
    walk_poses = [p for p in poses if p.startswith("walk-")]
    if len(walk_poses) == 4:
        walk_clip(
            [Image.open(out_dir / f"{p}.png").convert("RGBA") for p in walk_poses],
            out_dir,
            "walk",
        )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    prep = sub.add_parser("prepare", help="stand cell on the 720 bench canvas")
    prep.add_argument("--skin", default="avatar", help="asset dir under game.package")
    prep.add_argument("--out", type=Path, required=True)
    comp = sub.add_parser("composite", help="head-swap the committed cells")
    comp.add_argument("--edit", type=Path, required=True, help="the nano edit output")
    comp.add_argument(
        "--skin",
        action="append",
        default=[],
        help="manifest dir(s); first wins shared poses (default: avatar + avatar-gestures)",
    )
    comp.add_argument(
        "--poses",
        default="stand,walk-a,walk-b,walk-c,walk-d",
        help="comma-separated poses to composite",
    )
    comp.add_argument("--out", type=Path, required=True, help="output directory")
    args = parser.parse_args()

    if args.command == "prepare":
        prepare(args.skin, args.out)
        return
    skins = args.skin or ["avatar", "avatar-gestures"]
    composite(args.edit, skins, args.poses.split(","), args.out)


if __name__ == "__main__":
    main()
