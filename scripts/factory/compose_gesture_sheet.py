#!/usr/bin/env python3
"""Gesture-sheet composition — the ①c lane of the factory (asset-pipeline.md §4).

Builds one green-screen gesture sheet (stand + sit + sleep + wave +
dance-a..h) from the bench-approved takes, normalizes their scales, runs
the compose-time quality gates, and persists the per-pose neck-anchor
overrides into the order — then the standard importer
(import-avatar-sheet.py) cuts and imports it like any other sheet.

Why a lane of its own (the ①c bench findings, 2026-08-10):

- Sources arrive at three scales: nano-banana-2 stills upscale the 720px
  input canvas to 1024 (x1.4222), wan clips render it at 1440 (x2), and
  the stand cell is rebuilt from the committed 2x frame. Cells are
  normalized back to the 720 canvas scale and VERIFIED by hair-blob width
  against the stand (fail loud) — the constant-ratio assumption is
  checked, not trusted.
- The walk line's structural neck detection breaks on gesture poses
  (arms over the head fill the width-profile pinch; a lying sleeper has
  no vertical profile at all — both measured), so neck anchors are
  estimated here by the hair-blob method (stable ±2px across the dance
  cycle in the bench) and persisted as the order's `neckAnchors`
  overrides. The sleep pose's anchor is approximate by design (the head
  lies sideways; nothing renders from it today — the busy headgear
  overlay hides on sleep).
- The walk line's erase-then-paste head composite is NOT applied (it
  erases arms crossing above the neck line — measured); dance frames
  keep their video-native heads, gated by the calibrated per-frame
  palette-drift check instead.

Inputs are named by the order's `gestureSources` map (file → sha256 in
the R2 originals store), so a fresh clone reproduces the committed sheet
without the local takes.

Usage:
    python3 scripts/factory/compose_gesture_sheet.py \
        packages/client/src/game.package/avatar-gestures/order.json
    python3 scripts/upload-asset-originals.py <same order.json>
    python3 scripts/import-avatar-sheet.py <same order.json>
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))

import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

from factory.anchors import structure_neck  # noqa: E402
from factory.art_lint import check_palette_drift  # noqa: E402
from factory.compose_sheet import (  # noqa: E402
    cell_on_green,
    chroma_key,
    content_bbox,
)
from r2_originals import resolve_asset_path, resolve_original, validate_order_path  # noqa: E402

ASSET_ROOT = ROOT / "packages/client/src/game.package"

# The bench canvas geometry every take derives from (prepare_stand_canvas):
# the committed 2x stand frame upscaled to CANVAS_CHAR_H on a 720px green
# square. nano-banana-2 returns 1024px, wan renders 1440px.
CANVAS = 720
CANVAS_CHAR_H = 470
NANO_SIZE = 1024
WAN_SIZE = 1440

# Hair-blob scale verification tolerance, on sqrt(pixel count) — width was
# the first idea but breaks on the sleep pose (a lying head's horizontal
# hair extent is its front-to-back depth, 1.9x the upright width —
# measured); the area square root is rotation-invariant. Generative takes
# redraw the hair slightly (the wave take grew it ~9% linear — measured),
# so the tolerance is looser than a resize error would need but far
# tighter than the 1.42x/2x mistakes it exists to catch.
HAIR_SCALE_TOLERANCE = 0.15

# The adopted dance cycle (①c bench: clip frame 34 + 24-frame period,
# closure IoU 0.932, sampled every 3rd frame = DANCE_FRAME_MS cells).
DANCE_FRAMES = [34, 37, 40, 43, 46, 49, 52, 55]
# The sit clip's settled frame (motionless from ~80; 120 is deep inside).
SIT_FRAME = 120

CELL_PAD = 8


def extract_clip_frame(clip: Path, index: int, out: Path) -> Image.Image:
    """One 1-based frame of the clip, decoded losslessly via ffmpeg."""
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(clip),
            "-vf",
            f"select=eq(n\\,{index - 1})",
            "-vframes",
            "1",
            str(out),
        ],
        check=True,
        capture_output=True,
    )
    return Image.open(out).convert("RGBA")


def keyed_cell(img: Image.Image, scale: float) -> Image.Image:
    """Chroma-key, downscale to the 720-canvas scale, trim to content."""
    if scale != 1.0:
        img = img.resize(
            (max(1, round(img.width * scale)), max(1, round(img.height * scale))),
            Image.LANCZOS,
        )
    keyed = chroma_key(img)
    return keyed.crop(content_bbox(keyed))


def hair_stats(cell: Image.Image, hair_mean: np.ndarray) -> tuple[int, int, float]:
    """(centroid x, top y, sqrt of pixel count) of the cell's hair blob."""
    a = np.asarray(cell)
    opaque = a[:, :, 3] > 128
    rgb = a[:, :, :3].astype(int)
    dist = np.sqrt(((rgb - hair_mean) ** 2).sum(axis=2))
    hairish = opaque & (dist < 60)
    ys, xs = np.where(hairish)
    if len(xs) < 50:
        raise SystemExit("hair blob too small — wrong colors or wrong scale")
    return int(xs.mean()), int(ys.min()), float(len(xs)) ** 0.5


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    order_path = validate_order_path(Path(sys.argv[1]), ASSET_ROOT)
    order = json.loads(order_path.read_text())
    base = order_path.parent
    sources: dict[str, str] = order["gestureSources"]

    def source(rel: str) -> Path:
        return resolve_original(base, rel, sources, ASSET_ROOT)

    # Stand cell: the committed 2x stand frame upscaled exactly as
    # prepare_stand_canvas did for every bench generation, so the duplicate
    # stand cell carries the scale every other cell was generated at.
    stand_src = Image.open(
        resolve_asset_path(base, order["standSource"], ASSET_ROOT)
    ).convert("RGBA")
    stand_scale = CANVAS_CHAR_H / stand_src.height
    stand = stand_src.resize(
        (max(1, round(stand_src.width * stand_scale)), CANVAS_CHAR_H), Image.LANCZOS
    )
    stand = stand.crop(content_bbox(stand))

    # Hair reference from the stand head (above the structural neck — the
    # stand is upright, where the structural detector is calibrated).
    stand_neck = structure_neck(stand)
    sa = np.asarray(stand)
    head_rows = slice(0, int(stand_neck[1] * 0.7))
    opaque_head = sa[head_rows][:, :, 3][..., None] > 128
    hair_px = sa[head_rows][:, :, :3][opaque_head[:, :, 0]].astype(int)
    hair_mean = hair_px.mean(axis=0)
    head_h = stand_neck[1]
    stand_hair = hair_stats(stand, hair_mean)

    with tempfile.TemporaryDirectory() as tmp:
        tmpdir = Path(tmp)
        cells: dict[str, Image.Image] = {"stand": stand}
        cells["sit"] = keyed_cell(
            extract_clip_frame(source("sit-clip-original.mp4"), SIT_FRAME, tmpdir / "sit.png"),
            CANVAS / WAN_SIZE,
        )
        cells["sleep"] = keyed_cell(
            Image.open(source("sleep-original.png")).convert("RGBA"), CANVAS / NANO_SIZE
        )
        cells["wave"] = keyed_cell(
            Image.open(source("wave-original.png")).convert("RGBA"), CANVAS / NANO_SIZE
        )
        dance_clip = source("dance-clip-original.mp4")
        for pose, frame in zip("abcdefgh", DANCE_FRAMES):
            cells[f"dance-{pose}"] = keyed_cell(
                extract_clip_frame(dance_clip, frame, tmpdir / f"dance-{pose}.png"),
                CANVAS / WAN_SIZE,
            )

    if list(cells) != list(order["poses"]):
        raise SystemExit(f"pose mismatch: composed {list(cells)} vs order {order['poses']}")

    # Compose-time gates: scale verification (hair width vs stand) and the
    # calibrated per-cell palette drift vs the stand.
    failures: list[str] = []
    necks: dict[str, list[int]] = {}
    import_scale = order["standHeightPx"] / stand.height
    for pose, cell in cells.items():
        cx, top, hair_scale = hair_stats(cell, hair_mean)
        ratio = hair_scale / stand_hair[2]
        print(f"{pose}: hair scale ratio {ratio:.3f}")
        if abs(ratio - 1.0) > HAIR_SCALE_TOLERANCE:
            failures.append(f"{pose}: hair scale ratio {ratio:.3f} — scale normalization broke")
        drift = check_palette_drift(stand, cell)
        failures += [f"{pose}: {f}" for f in drift]
        # Neck estimate: the head is rigid, so its depth below the hair top
        # is the stand's (upright poses; sleep is approximate — see module
        # doc). Persisted in IMPORTED-frame coordinates.
        necks[pose] = [round(cx * import_scale), round((top + head_h) * import_scale)]
    if failures:
        for f in failures:
            print(f"  - {f}", file=sys.stderr)
        raise SystemExit("compose gates failed")

    cell_w = max(c.width for c in cells.values()) + CELL_PAD
    cell_h = max(c.height for c in cells.values()) + CELL_PAD
    sheet = Image.new("RGBA", (cell_w * len(cells), cell_h), (0, 255, 0, 255))
    for i, cell in enumerate(cells.values()):
        sheet.paste(cell_on_green(cell, cell_w, cell_h), (i * cell_w, 0))
    sheet_path = resolve_asset_path(base, order["sheet"], ASSET_ROOT)
    sheet.convert("RGB").save(sheet_path)

    order["neckAnchors"] = necks
    order_path.write_text(json.dumps(order, ensure_ascii=False, indent=2) + "\n")
    subprocess.run(["pnpm", "exec", "biome", "format", "--write", str(order_path)], check=True)
    print(f"wrote {sheet_path} ({len(cells)} cells {cell_w}x{cell_h}); neck anchors persisted")


if __name__ == "__main__":
    main()
