"""Bone-signature loop gates for rigged motion GLBs (factory v2 手順 2 —
the 3D-master ledger's registration machinery, master_models.json).

Why bones and not silhouettes: silhouette IoU cannot distinguish the
mirrored half-steps of a 3/4-view chibi, so it admits one-legged
half-cycles as "closed loops" (carry v2 の棄却根因 — 運転知見 22). Pose
signatures (per-bone quaternion + translation, the spike_tripo_render
`analyze` signal) live in joint space where a mirrored step is far away,
and the L/R foot tracks make the two-step structure directly measurable.

Inputs come from bpy_dump_bones.py, which samples on a SUBSTEPS-per-frame
grid: Meshy clips are authored at their own rate, so at 24fps the true
cycle length is fractional (rig walking measures 24.8 frames) and
integer-frame closure would fold a spurious sub-frame seam into the gate.

All closure metrics are RELATIVE: distances are divided by the median
one-frame pose step of the clip, so 1.0 ≈ "one frame's worth of motion"
(the seam size that made girl gangnam unusable — 運転知見 18).

Calibration (2026-08-14, R2-stored motion GLBs — factory-yield.md):
  clean loops   : boy walking 0.000 / girl walking 0.000 / girl running
                  0.000 / boy Texting_Walk 0.206 (closure), Texting loop
                  mean 0.493 (the only 2-instance positive clip)
  broken loops  : girl Gangnam_Groove retarget best closure 0.77 /
                  loop-mean 1.84 (no clean loop — the 2026-08-12 反証),
                  boy Carry_Heavy_Object_Walk best closure 0.62
  gait          : true two-step windows measure sign-flips exactly 2,
                  swing ≥ 0.89 both ways, half-period antiphase ≥ 0.97;
                  the carry-v2 42-frame half-cycle window flips once, a
                  double-period window flips 4 with antiphase −1.0
"""

from __future__ import annotations

from typing import NamedTuple

import numpy as np

# Relative single-pair closure at the fundamental window (≤ — smaller is
# tighter). Clean 0.000-0.206 vs broken ≥ 0.62 (calibration above).
CLOSURE_MAX = 0.35
# Whole-cycle consistency against the next instance, only measurable when
# the clip holds two instances (運転知見 17: single-pair closure can pass on
# a coincidental pose match). Positive 0.493 vs broken ≥ 1.84.
LOOP_MEAN_MAX = 1.0
# Gait (two-step) gate: both feet must lead with meaningful amplitude...
GAIT_MIN_SWING = 0.5
# ...the lead must change hands exactly twice per cycle (wrap included)...
GAIT_SIGN_FLIPS = 2
# ...and the second half must mirror the first (antiphase correlation).
GAIT_MIN_ANTIPHASE = 0.8
# Loop-mean is sampled every other fine step (loop_scan's stride precedent).
CONSISTENCY_STRIDE = 2


class LoopWindow(NamedTuple):
    """The fundamental loop in fine-grid index space (frames = idx/substeps)."""

    start: int
    period: int
    closure: float
    loop_mean: float | None


class GaitMetrics(NamedTuple):
    axis: int
    pos_swing: float
    neg_swing: float
    sign_flips: int
    antiphase: float


def frame_scale(signatures: np.ndarray, substeps: int) -> float:
    """Median one-frame pose step — the clip's own motion unit."""
    steps = np.linalg.norm(signatures[substeps:] - signatures[:-substeps], axis=1)
    scale = float(np.median(steps))
    if scale <= 0:
        raise SystemExit("static clip — no motion to loop")
    return scale


def closure_curve(signatures: np.ndarray, period: int, scale: float) -> np.ndarray:
    """Relative closure for every start at one period (vectorized)."""
    return np.linalg.norm(signatures[: len(signatures) - period] - signatures[period:], axis=1) / scale


def loop_mean_at(
    signatures: np.ndarray, start: int, period: int, scale: float
) -> float | None:
    """Mean relative distance of the cycle to its next instance, or None
    when the clip cannot hold two instances."""
    if start + 2 * period >= len(signatures):
        return None
    idx = np.arange(start, start + period, CONSISTENCY_STRIDE)
    return float(np.mean(np.linalg.norm(signatures[idx] - signatures[idx + period], axis=1)) / scale)


def best_loop_mean(
    signatures: np.ndarray, period: int, scale: float
) -> tuple[float, int] | None:
    limit = len(signatures) - 2 * period - 1
    if limit < 0:
        return None
    scored = [
        (loop_mean_at(signatures, start, period, scale), start)
        for start in range(limit + 1)
    ]
    return min((s, i) for s, i in scored if s is not None)


def scan_fundamental(
    signatures: np.ndarray,
    substeps: int,
    *,
    min_frames: int = 8,
    max_frames: int = 60,
) -> LoopWindow:
    """The smallest closable cycle in the clip, sub-frame aligned.

    Candidates are periods whose best closure passes CLOSURE_MAX; the
    smallest candidate wins (the fundamental-period rule foot_phase and
    loop_scan share — a double stride closes as well as a single), then the
    alignment is refined within one frame above it. Raises when nothing
    closes: a motion without a machine-verifiable loop must not be
    registered (the girl-gangnam shape).
    """
    n = len(signatures)
    scale = frame_scale(signatures, substeps)
    lo = min_frames * substeps
    hi = min(max_frames * substeps, n - 2)
    if hi < lo:
        raise SystemExit(f"clip too short for loop scan ({n} samples)")
    best_by_period: dict[int, tuple[float, int]] = {}
    for period in range(lo, hi + 1):
        curve = closure_curve(signatures, period, scale)
        start = int(np.argmin(curve))
        best_by_period[period] = (float(curve[start]), start)
    candidates = [p for p, (c, _) in best_by_period.items() if c <= CLOSURE_MAX]
    if not candidates:
        best_period = min(best_by_period, key=lambda p: best_by_period[p][0])
        closure, start = best_by_period[best_period]
        raise SystemExit(
            f"no closable cycle: best closure {closure:.3f} at period "
            f"{best_period / substeps:.2f}f start {start / substeps:.2f}f "
            f"(gate ≤ {CLOSURE_MAX}) — this motion cannot be a 3D master "
            "(girl gangnam precedent: retarget loop quality is per-character "
            "gacha, 運転知見 18)"
        )
    fundamental = min(candidates)
    # Refine the alignment within one frame above the fundamental: the true
    # fractional cycle sits between integer periods.
    period, (closure, start) = min(
        (
            (p, best_by_period[p])
            for p in range(fundamental, min(fundamental + substeps, hi) + 1)
        ),
        key=lambda item: item[1][0],
    )
    loop_mean = loop_mean_at(signatures, start, period, scale)
    if loop_mean is None:
        # The chosen start may sit too late for a second instance the clip
        # could otherwise hold — fall back to the best two-instance window.
        scored = best_loop_mean(signatures, period, scale)
        if scored is not None:
            loop_mean = scored[0]
    if loop_mean is not None and loop_mean > LOOP_MEAN_MAX:
        raise SystemExit(
            f"cycle at {start / substeps:.2f}f period {period / substeps:.2f}f "
            f"closes ({closure:.3f}) but drifts against its next instance "
            f"(loop-mean {loop_mean:.3f} > {LOOP_MEAN_MAX}) — a coincidental "
            "pose match, not a loop (運転知見 17)"
        )
    return LoopWindow(start=start, period=period, closure=closure, loop_mean=loop_mean)


def gait_metrics(
    left_foot: np.ndarray, right_foot: np.ndarray, start: int, period: int
) -> GaitMetrics:
    """Two-step structure of the window from the L−R foot signal.

    The forward axis is the horizontal axis (x or y — z is up in Blender
    world space) with the larger L−R variance: in-place gaits swing feet
    forward/backward, while the lateral axis only carries the constant
    stance width.
    """
    diff = left_foot[start : start + period] - right_foot[start : start + period]
    axis = int(np.argmax(diff.var(axis=0)[:2]))
    signal = diff[:, axis]
    amplitude = float(np.abs(signal).max())
    if amplitude <= 0:
        raise SystemExit("feet never separate along a horizontal axis — not a gait")
    wrapped = np.append(signal, signal[0])
    # Zero samples carry no lead information — drop them so a foot crossing
    # sampled exactly at zero counts as one lead change, not two.
    signs = np.sign(wrapped)
    signs = signs[signs != 0]
    flips = int((np.diff(signs) != 0).sum())
    antiphase = float(
        np.corrcoef(signal, -np.roll(signal, period // 2))[0, 1]
    )
    return GaitMetrics(
        axis=axis,
        pos_swing=float(signal.max()) / amplitude,
        neg_swing=float(-signal.min()) / amplitude,
        sign_flips=flips,
        antiphase=antiphase,
    )


def check_gait(metrics: GaitMetrics) -> list[str]:
    """Gate failures for a window that must hold one full two-step cycle."""
    failures: list[str] = []
    if metrics.pos_swing < GAIT_MIN_SWING or metrics.neg_swing < GAIT_MIN_SWING:
        failures.append(
            f"one-sided gait: swing +{metrics.pos_swing:.2f}/−{metrics.neg_swing:.2f} "
            f"(need ≥ {GAIT_MIN_SWING} both ways) — only one foot ever leads"
        )
    if metrics.sign_flips != GAIT_SIGN_FLIPS:
        failures.append(
            f"foot lead changes {metrics.sign_flips}× per cycle (need exactly "
            f"{GAIT_SIGN_FLIPS}) — a half-cycle window flips once, a double "
            "period flips four times (運転知見 22)"
        )
    if metrics.antiphase < GAIT_MIN_ANTIPHASE:
        failures.append(
            f"half-period antiphase {metrics.antiphase:.2f} < {GAIT_MIN_ANTIPHASE} "
            "— the second step does not mirror the first"
        )
    return failures
