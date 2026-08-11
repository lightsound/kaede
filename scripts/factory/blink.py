"""Blink-avoiding cell selection for replace outputs (fal replace lane).

wan replace generates the character's face fresh, so blink frames appear
that the master take never had (measured PR #101: gangnam 2/period, the
720p walk take blinked in bursts). The lane samples its sheet cells from
whichever phase-equivalent frame (index ± k·period — the cycle_scan
substitution rule) has the openest eyes.

Eye-openness signal: dark pixels horizontally flanked by skin within the
head band. Chibi eyes are large dark ellipses on light skin; a blink
redraws them as thin arcs, collapsing the flanked-dark count. Hair is dark
too but sits against hair/background, not between skin — the flanking test
is what separates them. Calibrated 2026-08-11 on the PR #101 takes: known
blink frames of the girl 720p walk replace score 0.35-0.65 of the clip
median, its open-eye frames ≈ 1.0, and the blink-free boy master never
drops below 0.83 — BLINK_RELATIVE = 0.72 splits the two populations.

The score is pose-confounded in absolute terms (an arm across the face
lowers it — measured on the gangnam takes), which is why selection only
compares candidates WITHIN one slot (same phase = same pose) and the
absolute threshold is only a residual-suspect flag for the visual gate,
never a lone verdict (運転知見 14).
"""

from __future__ import annotations

from statistics import median

import numpy as np
from PIL import Image

OPAQUE = 128
DARK_LUMA_MAX = 110
SKIN_LUMA_MIN = 140
# Horizontal skin-flank distances (px at the take's native scale, 640px
# canvas): inside an open chibi eye the nearest skin is 4-12px away.
FLANK_RANGE = range(4, 13)
# Head band: the top half of the silhouette holds the whole chibi face.
HEAD_BAND_FRACTION = 0.5
BLINK_RELATIVE = 0.72


def eye_openness_score(keyed: Image.Image) -> float:
    """Flanked-dark pixel count of one chroma-keyed RGBA frame."""
    a = np.asarray(keyed.convert("RGBA")).astype(int)
    alpha = a[:, :, 3] >= OPAQUE
    rows = np.where(alpha.any(axis=1))[0]
    if len(rows) == 0:
        return 0.0
    r, g, b = a[:, :, 0], a[:, :, 1], a[:, :, 2]
    luma = (r * 299 + g * 587 + b * 114) // 1000
    band = np.zeros_like(alpha)
    top = rows.min()
    band[top : top + int((rows.max() - top) * HEAD_BAND_FRACTION)] = True
    dark = alpha & band & (luma < DARK_LUMA_MAX)
    skin = alpha & (luma > SKIN_LUMA_MIN) & (r >= g) & (g >= b - 10)
    flank_left = np.zeros_like(alpha)
    flank_right = np.zeros_like(alpha)
    # np.roll wraps at the borders (a right-edge skin pixel can "flank" a
    # left-edge dark pixel) — negligible here: the takes center a single
    # character on a 640px canvas, and scores are only compared within one
    # clip, so any wrap bias is constant across its frames.
    for d in FLANK_RANGE:
        flank_left |= np.roll(skin, d, axis=1)
        flank_right |= np.roll(skin, -d, axis=1)
    return float((dark & flank_left & flank_right).sum())


def phase_candidates(slot: int, period: int, frame_count: int) -> list[int]:
    """Every in-range frame at the same phase (slot + k·period)."""
    first = slot % period
    return list(range(first, frame_count, period))


def select_cells(
    scores: list[float], start: int, period: int, cells: int
) -> tuple[list[int], list[int]]:
    """(chosen frame indices, residual blink suspects) for `cells` slots.

    Slots are spaced evenly over one period from `start`. Per slot the
    phase-equivalent candidate with the highest eye score wins; ±1-frame
    jitter (the cycle_scan fallback order) is consulted only when every
    pure candidate sits under the blink threshold. A slot whose winner
    still sits under it lands in the suspect list — the visual gate
    decides whether the take is retaken.
    """
    if period < cells:
        raise SystemExit(f"period {period} shorter than {cells} cells")
    reference = median(scores)
    if reference <= 0:
        raise SystemExit("eye scores are all zero — wrong frames?")
    threshold = BLINK_RELATIVE * reference
    chosen: list[int] = []
    suspects: list[int] = []
    for i in range(cells):
        slot = start + round(i * period / cells)
        pure = phase_candidates(slot, period, len(scores))
        best = max(pure, key=lambda f: scores[f])
        if scores[best] < threshold:
            jitter = [
                c + d
                for c in pure
                for d in (-1, 1)
                if 0 <= c + d < len(scores)
            ]
            best = max([best, *jitter], key=lambda f: scores[f])
        if scores[best] < threshold:
            suspects.append(best)
        chosen.append(best)
    return chosen, suspects
