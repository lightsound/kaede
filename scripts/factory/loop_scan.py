"""Silhouette-IoU loop discovery for green-screen motion takes (fal replace
lane — the machine loop-closure check the master-take ledger requires).

The walk line's foot-phase autocorrelation (foot_phase.py) assumes striding
feet; dance takes swing arms and bounce instead, so the lane measures loops
on alpha-silhouette IoU in ABSOLUTE canvas coordinates (the takes are
in-place on a green canvas, so no alignment step — a drifting character
correctly scores as a broken loop).

(start, period) are optimized JOINTLY on whole-loop consistency — the mean
IoU of one full cycle against its next instance — not on a single wrap
pair: the girl-gangnam candidate take scores a healthy single closure
(0.976) on a coincidental pose match at a wrong period while its whole
loop only aligns at 0.87 (measured 2026-08-11), and the single-pair metric
would have registered that broken cycle as a master. Requiring two full
instances also guarantees the phase-equivalent substitution headroom the
blink selection needs (blink.py).

Calibration (the four PR #101 master candidates, 2026-08-11): approved
takes score loop-mean 0.976-0.993 / closure 0.956-0.993; the uneven
girl-gangnam candidate 0.929 / 0.908. Master gates 0.94 / 0.93 split them.
Replace OUTPUTS sit systematically lower on the same metric — identity
redraw noise (glasses, plaid shimmer) costs ~0.05 IoU even on takes the
owner accepted (spike outputs measure loop-mean 0.892-0.924 / closure
0.921-0.967) — so the produce gate has its own floors (replace_lane.py),
calibrated to reject the broken-cycle shape (0.869) without failing
healthy generations.

Period preference mirrors foot_phase's fundamental-period rule: a walk's
double stride scores the same consistency (girl walk: 24 -> 0.993 vs
48 -> 0.992), so the smallest period within FUNDAMENTAL_MARGIN wins. Start
preference is the earliest within START_MARGIN — an early start leaves the
longest trim window (more substitution instances per replace dollar).
"""

from __future__ import annotations

import numpy as np
from PIL import Image

OPAQUE = 128
MASK_WIDTH = 160
# Whole-loop consistency floor (see calibration above).
LOOP_MEAN_MIN = 0.94
# Single wrap-pair floor: the ①c dance bench adopted 0.932 and every fal
# replace output measured 0.96-0.99 (factory-yield.md).
CLOSURE_MIN = 0.93
FUNDAMENTAL_MARGIN = 0.01
START_MARGIN = 0.005
# Every other frame of the cycle is compared (24fps motion is smooth at
# 2-frame steps; halves the quadratic scan cost).
CONSISTENCY_STRIDE = 2


def silhouette_mask(keyed: Image.Image) -> np.ndarray:
    """Downscaled boolean silhouette of a chroma-keyed RGBA frame."""
    height = max(1, round(keyed.height * MASK_WIDTH / keyed.width))
    small = keyed.resize((MASK_WIDTH, height), Image.BILINEAR)
    return np.asarray(small)[:, :, 3] >= OPAQUE


def mask_iou(a: np.ndarray, b: np.ndarray) -> float:
    union = int(np.logical_or(a, b).sum())
    if union == 0:
        return 0.0
    return int(np.logical_and(a, b).sum()) / union


def loop_consistency(masks: list[np.ndarray], start: int, period: int) -> float:
    """Mean IoU of the cycle at `start` against its next instance."""
    if start + 2 * period > len(masks):
        raise SystemExit(
            f"loop at {start} needs {start + 2 * period} frames, clip has {len(masks)}"
        )
    pairs = [
        mask_iou(masks[start + i], masks[start + period + i])
        for i in range(0, period, CONSISTENCY_STRIDE)
    ]
    return float(np.mean(pairs))


def best_loop_start(
    masks: list[np.ndarray], period: int, *, start_max: int | None = None
) -> tuple[int, float]:
    """(start, loop consistency) for `period`.

    Among the starts within START_MARGIN of the best consistency, the one
    with the strongest wrap closure wins (the wrap pair is where a sampled
    cell loop visibly pops), earliest on ties (an early start leaves the
    longest trim window — more substitution instances per replace dollar).
    """
    limit = len(masks) - 2 * period
    if start_max is not None:
        limit = min(limit, start_max)
    if limit < 0:
        raise SystemExit(f"clip too short for two instances of period {period}")
    scored = [(loop_consistency(masks, s, period), s) for s in range(limit + 1)]
    best = max(score for score, _ in scored)
    start = min(
        (s for score, s in scored if score >= best - START_MARGIN),
        key=lambda s: (-mask_iou(masks[s], masks[s + period]), s),
    )
    return start, loop_consistency(masks, start, period)


def find_loop(
    masks: list[np.ndarray], *, min_period: int = 12, max_period: int = 60
) -> tuple[int, int, float, float]:
    """(start, period, loop mean, wrap closure) of the best loop in the clip.

    Raises when no (start, period) passes the gates — a take without a
    clean machine-verifiable loop must not be registered as a master.
    """
    max_period = min(max_period, (len(masks) - 1) // 2)
    if max_period < min_period:
        raise SystemExit(f"clip too short for loop scan ({len(masks)} frames)")
    by_period: dict[int, tuple[float, int]] = {}
    for period in range(min_period, max_period + 1):
        start, score = best_loop_start(masks, period)
        by_period[period] = (score, start)
    best_score = max(score for score, _ in by_period.values())
    period = next(
        p for p in sorted(by_period)
        if by_period[p][0] >= best_score - FUNDAMENTAL_MARGIN
    )
    score, start = by_period[period]
    closure = mask_iou(masks[start], masks[start + period])
    if score < LOOP_MEAN_MIN or closure < CLOSURE_MIN:
        raise SystemExit(
            f"no clean loop: best period {period} at start {start} scores "
            f"loop-mean {score:.3f} / closure {closure:.3f} "
            f"(need ≥ {LOOP_MEAN_MIN} / {CLOSURE_MIN}) — this take cannot be a master"
        )
    return start, period, score, closure


def verify_loop(masks: list[np.ndarray], period: int) -> tuple[int, float, float]:
    """(start, loop mean, wrap closure) for a KNOWN period (produce: the
    replace output inherits the master's timing, only quality is re-proved)."""
    start, score = best_loop_start(masks, period)
    return start, score, mask_iou(masks[start], masks[start + period])
