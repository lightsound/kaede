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
    check_neck_junction,
    check_palette_drift,
)
from factory.compose_sheet import (  # noqa: E402
    chroma_key,
    compose_walk_sheet,
    content_bbox,
)
from factory.foot_phase import (  # noqa: E402
    _find_period,
    load_signals,
    load_spreads,
    stride_quad,
)

POSES = ("walk-a", "walk-b", "walk-c", "walk-d")
SKIP_HEAD_SECONDS = 1.5
FPS = 30.0
# Phase-equivalent strides to try per failing slot, then ±1 jitter. Only
# the NEIGHBORING stride: a substitution from a far part of the clip once
# passed the pixel gates while carrying a different rendering style (pink
# legs, near-clone mid poses) — style coherence decays with distance.
SUBSTITUTE_STRIDES = (1, -1)
MAX_CYCLE_ATTEMPTS = 12


def _evaluate(
    stand_raw: Path,
    frames: list[Path],
    idx: dict[str, int],
    *,
    expect_leg_phase: bool = True,
) -> list[str]:
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
        # 192px = the 4x shipping scale (factory-v2 step-1 ruling); the art
        # lint's px gates are calibrated at this scale, so mirroring them on
        # 96px cells would judge with doubled tolerances.
        scale = 192 / cells[0].height
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
            # Junction gate (①d 論点 6): a semi-transparent neck bridge reads
            # as a break at play speed — catch it per slot so the substitution
            # loop can swap the frame instead of failing the whole take.
            failures += [
                f"{pose}: {f}" for f in check_neck_junction(cell, list(neck))
            ]
        # Leg-phase gate (the owner-caught failure shapes): tag the SECOND
        # frame of the near-clone pair so the substitution loop retries it.
        # Carry cycles stride gently with near-clone-adjacent poses by spec,
        # so the caller excludes them (the run_lint rule).
        if expect_leg_phase:
            for failure in check_leg_phase(dict(zip(POSES, cells[1:]))):
                slot = next(
                    (p for p in reversed(POSES) if f"{p} " in failure or failure.startswith(p)),
                    "walk-d",
                )
                failures.append(f"{slot}: {failure}")
        return failures


def _substitutes(
    index: int, period: int, taken: set[int], lo: int, limit: int
) -> list[int]:
    """Phase-equivalent alternatives for one slot, spacing-safe.

    `lo` is the master's loop start: a `-period` hop (or `-1` jitter) from
    a slot near the loop head would otherwise land in the pre-loop ease-in
    — the exact untrustworthy gait region the loop-windowed anchor exists
    to avoid (the girl inverted-bob差し戻し).
    """
    options = [index + k * period for k in SUBSTITUTE_STRIDES]
    options += [index + 1, index - 1]
    return [
        i
        for i in options
        if lo <= i < limit and all(abs(i - t) >= 2 for t in taken)
    ]


def _candidate_quads(
    frames: list[Path],
    *,
    pinned_contact: int | None,
    period: int | None,
    loop_start: int,
    skip_head_seconds: float,
) -> tuple[list[dict[str, int]], int]:
    """(candidate walk-a..d index quads, period) for scan_clip.

    Master-lane clips (period machine-known from the ledger) anchor on the
    leg-spread maximum INSIDE the loop window (stride_quad): the girl
    sheet's inverted bob traced back to this function scanning from frame
    0 while her master's loop starts at 31 — the pre-loop ease-in gait
    passed every pixel gate but held no contact/passing structure. Later
    candidates step whole periods so every quad stays phase-aligned.

    Unknown-period clips (the retired wan lane, still used by run_avatar's
    legacy path) keep the foot-signal contact scan.
    """
    if period is not None:
        spreads = load_spreads(frames)
        base = (
            {pose: pinned_contact + round(n * period / 4) for n, pose in enumerate(POSES)}
            if pinned_contact is not None
            else stride_quad(spreads, loop_start, len(frames), period)
        )
        quads = []
        offset = 0
        while base["walk-d"] + offset < len(frames):
            quads.append({pose: i + offset for pose, i in base.items()})
            offset += period
        return quads, period

    signals = load_signals(frames)
    start = min(len(signals) - 16, int(skip_head_seconds * FPS))
    period = _find_period(signals[start:], min_period=12, max_period=28)
    quarter = period // 4
    contacts: list[int] = []
    i = start
    while i + period <= len(frames):
        contacts.append(max(range(i, i + period), key=lambda k: signals[k]))
        i += period
    if pinned_contact is not None:
        contacts = [pinned_contact]
    quads = [
        {pose: contact + n * quarter for n, pose in enumerate(POSES)}
        for contact in contacts
    ]
    return [q for q in quads if q["walk-d"] < len(frames)], period


def scan_clip(
    stand_raw: Path,
    frames_dir: Path,
    *,
    pinned_contact: int | None = None,
    period: int | None = None,
    loop_start: int = 0,
    skip_head_seconds: float = SKIP_HEAD_SECONDS,
    expect_leg_phase: bool = True,
) -> dict[str, list[Path]]:
    """The first stride cycle (optionally pinned) that passes the checks.

    `period` short-circuits the detection when the clip's cycle is already
    machine-known (a registered master take / a replace output inheriting
    it — master_takes.json) and switches the anchor to the loop-windowed
    stride quad (see _candidate_quads); `loop_start` is that master's
    verified loop start. `skip_head_seconds` drops to 0 for those clips: a
    trimmed master has no wan-style ease-in to skip, and skipping would
    eat most of its 2-loop window.
    """
    frames = sorted(frames_dir.glob("frame_*.png"))
    if len(frames) < 16:
        raise SystemExit(f"need ≥16 frames to scan, got {len(frames)}")
    quads, period = _candidate_quads(
        frames,
        pinned_contact=pinned_contact,
        period=period,
        loop_start=loop_start,
        skip_head_seconds=skip_head_seconds,
    )
    print(f"cycle scan: period={period} quads={[q['walk-a'] for q in quads]}")

    rejects: list[str] = []
    for idx in quads:
        failures = _evaluate(stand_raw, frames, idx, expect_leg_phase=expect_leg_phase)
        attempts = 1
        while failures and attempts < MAX_CYCLE_ATTEMPTS:
            slot = failures[0].split(":")[0]
            if slot not in idx:
                break
            taken = {v for k, v in idx.items() if k != slot}
            replaced = False
            for substitute in _substitutes(
                idx[slot], period, taken, loop_start, len(frames)
            ):
                trial = {**idx, slot: substitute}
                trial_failures = _evaluate(
                    stand_raw, frames, trial, expect_leg_phase=expect_leg_phase
                )
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
        rejects.append(f"contact {idx['walk-a']}: {failures[0]}")

    raise SystemExit(
        "no clean cycle in this clip — retake the video ("
        + "; ".join(rejects[:4])
        + ")"
    )
