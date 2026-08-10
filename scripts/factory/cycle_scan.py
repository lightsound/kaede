"""Drift-aware walk-cycle selection over the whole clip (①b 運転知見の機械化).

A wan clip holds ~5-7 strides but the auto-pick used to judge only one: when
a frame in that cycle failed the head/drift checks the whole take was
retaken, even though a clean cycle usually exists elsewhere in the SAME
clip (measured on the girl: 2 of 7 strides clean on a take whose auto-pick
failed). This module scans every stride and, per failing slot, tries
PHASE-EQUIVALENT substitutes — the same phase one or more strides away
(index ± k·period), then a ±1-frame jitter. Phase-preserving substitution
is what keeps the cycle's timing uniform: a naive nearest-neighbor swap
once produced a cycle whose fourth frame sat 1 frame after the third, and
the loop read as a moonwalk (videoReview fail 2026-08-09).

The checks here mirror the art lint (structure neck, head consistency,
palette drift) on approximately import-scaled cells; the real import + lint
still runs afterwards as the authoritative gate.
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from factory.anchors import structure_neck  # noqa: E402
from factory.art_lint import (  # noqa: E402
    check_head_consistency,
    check_leg_phase,
    check_palette_drift,
)
from factory.compose_sheet import (  # noqa: E402
    chroma_key,
    compose_walk_sheet,
    content_bbox,
)
from factory.foot_phase import _find_period, load_signals  # noqa: E402

POSES = ("walk-a", "walk-b", "walk-c", "walk-d")
SKIP_HEAD_SECONDS = 1.5
FPS = 30.0
# Phase-equivalent strides to try per failing slot, then ±1 jitter. Only
# the NEIGHBORING stride: a substitution from a far part of the clip once
# passed the pixel gates while carrying a different rendering style (pink
# legs, near-clone mid poses) — style coherence decays with distance.
SUBSTITUTE_STRIDES = (1, -1)
MAX_CYCLE_ATTEMPTS = 12


def _evaluate(stand_raw: Path, frames: list[Path], idx: dict[str, int]) -> list[str]:
    """Compose the candidate cycle and run import-approximate checks."""
    candidates = {pose: [frames[i]] for pose, i in idx.items()}
    with tempfile.TemporaryDirectory() as scratch:
        sheet_path = Path(scratch) / "sheet.png"
        try:
            compose_walk_sheet(stand_raw, candidates, sheet_path)
        except SystemExit as exc:
            return [f"compose: {exc}"]
        sheet = Image.open(sheet_path).convert("RGBA")
        cell_w = sheet.width // 5
        cells = []
        for i in range(5):
            cell = chroma_key(sheet.crop((i * cell_w, 0, (i + 1) * cell_w, sheet.height)))
            cells.append(cell.crop(content_bbox(cell)))
        scale = 96 / cells[0].height
        cells = [
            c.resize(
                (max(1, round(c.width * scale)), max(1, round(c.height * scale))),
                Image.LANCZOS,
            )
            for c in cells
        ]
        stand = cells[0]
        stand_neck = structure_neck(stand)
        failures: list[str] = []
        for pose, cell in zip(POSES, cells[1:]):
            try:
                neck = structure_neck(cell)
            except SystemExit as exc:
                failures.append(f"{pose}: neck — {exc}")
                continue
            failures += [
                f"{pose}: {f}"
                for f in check_head_consistency(stand, stand_neck[1], cell, neck[1])
            ]
            failures += [f"{pose}: {f}" for f in check_palette_drift(stand, cell)]
        # Leg-phase gate (the owner-caught failure shapes): tag the contact
        # slots so the substitution loop retries them.
        for failure in check_leg_phase({"stand": stand, **dict(zip(POSES, cells[1:]))}):
            failures.append(f"walk-c: {failure}" if "opposite legs" in failure else f"walk-d: {failure}")
        return failures


def _substitutes(index: int, period: int, taken: set[int], limit: int) -> list[int]:
    """Phase-equivalent alternatives for one slot, spacing-safe."""
    options = [index + k * period for k in SUBSTITUTE_STRIDES]
    options += [index + 1, index - 1]
    return [
        i
        for i in options
        if 0 <= i < limit and all(abs(i - t) >= 2 for t in taken)
    ]


def scan_clip(
    stand_raw: Path,
    frames_dir: Path,
    *,
    pinned_contact: int | None = None,
) -> dict[str, list[Path]]:
    """The first stride cycle (optionally pinned) that passes the checks."""
    frames = sorted(frames_dir.glob("frame_*.png"))
    if len(frames) < 16:
        raise SystemExit(f"need ≥16 frames to scan, got {len(frames)}")
    signals = load_signals(frames)
    start = min(len(signals) - 16, int(SKIP_HEAD_SECONDS * FPS))
    period = _find_period(signals[start:], min_period=12, max_period=28)
    quarter = period // 4

    contacts: list[int] = []
    i = start
    while i + period < len(frames) - period:
        contacts.append(max(range(i, i + period), key=lambda k: signals[k]))
        i += period
    if pinned_contact is not None:
        contacts = [pinned_contact]
    print(f"cycle scan: period={period} contacts={contacts}")

    rejects: list[str] = []
    for contact in contacts:
        idx = {pose: contact + n * quarter for n, pose in enumerate(POSES)}
        if idx["walk-d"] >= len(frames):
            continue
        failures = _evaluate(stand_raw, frames, idx)
        attempts = 1
        while failures and attempts < MAX_CYCLE_ATTEMPTS:
            slot = failures[0].split(":")[0]
            if slot not in idx:
                break
            taken = {v for k, v in idx.items() if k != slot}
            replaced = False
            for substitute in _substitutes(idx[slot], period, taken, len(frames)):
                trial = {**idx, slot: substitute}
                trial_failures = _evaluate(stand_raw, frames, trial)
                attempts += 1
                if not any(f.startswith(slot) for f in trial_failures):
                    idx, failures, replaced = trial, trial_failures, True
                    break
                if attempts >= MAX_CYCLE_ATTEMPTS:
                    break
            if not replaced:
                break
        if not failures:
            print(f"cycle scan: clean cycle {idx}")
            return {pose: [frames[i]] for pose, i in idx.items()}
        rejects.append(f"contact {contact}: {failures[0]}")

    raise SystemExit(
        "no clean cycle in this clip — retake the video ("
        + "; ".join(rejects[:4])
        + ")"
    )
