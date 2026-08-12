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

Per-order source shapes (the girl sheet, 2026-08-12, extends the boy
defaults without touching them):

- sit: `sit-original.png` in gestureSources = a nano still (the
  cross-legged floor sit passed one-shot on the girl — the 2026-08-10
  candidate-D precedent); otherwise the boy's `sit-clip-original.mp4`
  frame SIT_FRAME.
- dance: an order `danceMaster` key ("motion/family") cuts the cells
  straight from the registered master take (master_takes.json — no
  replace call, no charge): the ledger's loop (start, period) anchors
  the phase-even slots, blink.py picks the openest-eyed
  phase-equivalent frame per slot (the master is a seedance
  generation, so blink frames exist that a wan clip's cells would
  not), and scales are normalized by the median hair-blob ratio
  against the stand — the master's canvas scale is not the bench
  canvas's, so a constant ratio cannot be assumed (the replace lane's
  normalization, re-verified per cell by the same gate). Otherwise
  the boy's `dance-clip-original.mp4` + DANCE_FRAMES.

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

from factory.anchors import hair_reference, hair_stats  # noqa: E402
from factory.art_lint import check_gesture_cell  # noqa: E402
from factory.blink import eye_openness_score, select_cells  # noqa: E402
from factory.compose_sheet import (  # noqa: E402
    cell_on_green,
    chroma_key,
    chroma_key_greenwear,
    content_bbox,
)
from factory.loop_scan import silhouette_mask, verify_loop  # noqa: E402
from factory.video import extract_frames  # noqa: E402
from r2_originals import resolve_asset_path, resolve_original, validate_order_path  # noqa: E402

LEDGER_PATH = Path(__file__).resolve().parent / "master_takes.json"

ASSET_ROOT = ROOT / "packages/client/src/game.package"

# The bench canvas geometry every take derives from (prepare_stand_canvas):
# the committed 2x stand frame upscaled to CANVAS_CHAR_H on a 720px green
# square. nano-banana-2 returns 1024px, wan renders 1440px.
CANVAS = 720
CANVAS_CHAR_H = 470
NANO_SIZE = 1024
WAN_SIZE = 1440

# Hair-blob scale machinery (reference, stats, tolerance) is shared with
# the fal replace lane: factory.anchors (hair_reference / hair_stats) and
# factory.art_lint (check_gesture_cell / HAIR_SCALE_TOLERANCE).

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


def master_dance_cells(order: dict, clip: Path, reference) -> dict[str, Image.Image]:
    """Dance cells cut straight from a registered master take (no charge).

    The ledger entry is the contract: its sha256 must match the order's
    recorded source (a silently different clip would re-anchor every cell),
    its loop quality is re-proved on the extracted frames, and its (start,
    period) anchors the same phase-even slots a replace output would get —
    so the family's pose grid stays canonical across characters.
    """
    ledger = json.loads(LEDGER_PATH.read_text())
    meta = ledger["masters"].get(order["danceMaster"])
    if meta is None:
        raise SystemExit(
            f"danceMaster {order['danceMaster']!r} is not in the ledger "
            f"(available: {sorted(ledger['masters'])})"
        )
    recorded = order["gestureSources"].get("dance-master-original.mp4")
    if recorded != meta["masterSha256"]:
        raise SystemExit(
            f"gestureSources records dance-master-original.mp4 {recorded} but the "
            f"ledger's {order['danceMaster']} master is {meta['masterSha256']} — "
            "the order and the ledger disagree on which take the cells come from"
        )

    with tempfile.TemporaryDirectory() as tmp:
        frame_paths = extract_frames(clip, Path(tmp) / "frames")
        if len(frame_paths) != meta["frames"]:
            raise SystemExit(
                f"master extracted {len(frame_paths)} frames, ledger records "
                f"{meta['frames']} — wrong or re-encoded clip"
            )
        # The green-wear-safe key is the master-take contract (replace lane;
        # the blink calibration was measured on frames keyed this way).
        frames = [chroma_key_greenwear(Image.open(p)) for p in frame_paths]

    period = meta["loop"]["period"]
    start, loop_mean, closure = verify_loop(
        [silhouette_mask(img) for img in frames], period
    )
    print(
        f"master loop: start={start} period={period} "
        f"loop-mean={loop_mean:.3f} closure={closure:.3f} "
        f"(ledger {meta['loop']['loopMeanIou']:.3f}/{meta['loop']['closureIou']:.3f})"
    )

    scores = [eye_openness_score(img) for img in frames]
    chosen, suspects = select_cells(scores, meta["loop"]["start"], period, 8)
    print(f"dance cells (0-based master frames): {chosen}")
    if suspects:
        print(f"blink suspects (visual gate must confirm): {suspects}")

    # The master's canvas scale is unknown to the bench geometry, so the
    # cells are normalized to the stand by the MEDIAN hair-blob ratio
    # (rotation-invariant; the replace lane's rule) — each cell is then
    # re-verified individually by check_gesture_cell.
    raw = [frames[i].crop(content_bbox(frames[i])) for i in chosen]
    ratios = [hair_stats(c, reference.mean)[2] / reference.scale for c in raw]
    normalize = 1.0 / float(np.median(ratios))
    return {
        f"dance-{pose}": cell.resize(
            (max(1, round(cell.width * normalize)), max(1, round(cell.height * normalize))),
            Image.LANCZOS,
        )
        for pose, cell in zip("abcdefgh", raw)
    }


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
    reference = hair_reference(stand)

    with tempfile.TemporaryDirectory() as tmp:
        tmpdir = Path(tmp)
        cells: dict[str, Image.Image] = {"stand": stand}
        if "sit-original.png" in sources:
            cells["sit"] = keyed_cell(
                Image.open(source("sit-original.png")).convert("RGBA"), CANVAS / NANO_SIZE
            )
        else:
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
        if order.get("danceMaster"):
            cells.update(
                master_dance_cells(order, source("dance-master-original.mp4"), reference)
            )
        else:
            dance_clip = source("dance-clip-original.mp4")
            for pose, frame in zip("abcdefgh", DANCE_FRAMES):
                cells[f"dance-{pose}"] = keyed_cell(
                    extract_clip_frame(dance_clip, frame, tmpdir / f"dance-{pose}.png"),
                    CANVAS / WAN_SIZE,
                )

    if list(cells) != list(order["poses"]):
        raise SystemExit(f"pose mismatch: composed {list(cells)} vs order {order['poses']}")

    # Compose-time gates: scale verification (hair blob vs stand) and the
    # calibrated per-cell palette drift vs the stand (check_gesture_cell;
    # the sleep neck estimate is approximate by design — see module doc).
    failures: list[str] = []
    necks: dict[str, list[int]] = {}
    import_scale = order["standHeightPx"] / stand.height
    for pose, cell in cells.items():
        cell_failures, neck = check_gesture_cell(reference, import_scale, pose, cell)
        failures += cell_failures
        necks[pose] = neck
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
