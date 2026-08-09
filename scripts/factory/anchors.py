"""Structure-based anchor detection (①b art lint — no skin-color heuristics).

The ①b(a)⑵ spike measured two failures of color/heuristic detection:
- neck narrowest-row falls to the hips when a hoodie widens the neck row
- skin-tone blob detection contaminates on beige clothes

Both are replaced here by silhouette structure: the width profile of opaque
rows. Chibi heads are typically WIDER than the torso, so the neck is the
*first* significant valley below the head peak (not the global minimum of
a chin-to-hip band — that is what picked the waist on hoodies). Hand
(carry) is the near-side protrusion around waist height.
"""

from __future__ import annotations

from PIL import Image

OPAQUE = 128
# A chibi neck is a deep pinch relative to the head (boy-basic: 12/51 ≈ 0.24).
# Hoodie-widened necks that never drop below this fraction fail loud so the
# order can supply neckAnchors instead of silently landing on the waist.
NECK_MAX_FRAC_OF_HEAD = 0.55


def opaque_spans(frame: Image.Image) -> list[tuple[int, int] | None]:
    """Per-row (x0, x1) of opaque pixels, or None for empty rows."""
    alpha = frame.getchannel("A").load()
    w, h = frame.size
    spans: list[tuple[int, int] | None] = []
    for y in range(h):
        xs = [x for x in range(w) if alpha[x, y] >= OPAQUE]
        spans.append((xs[0], xs[-1]) if xs else None)
    return spans


def _widths(spans: list[tuple[int, int] | None]) -> list[float]:
    return [float(s[1] - s[0] + 1) if s else 0.0 for s in spans]


def _smooth(values: list[float], radius: int = 1) -> list[float]:
    if radius <= 0:
        return values
    out = []
    n = len(values)
    for i in range(n):
        lo, hi = max(0, i - radius), min(n, i + radius + 1)
        window = values[lo:hi]
        out.append(sum(window) / len(window))
    return out


def structure_neck(frame: Image.Image) -> tuple[int, int]:
    """Neck = first deep width-valley below the head peak.

    Walks downward from the head's widest row. Once the silhouette narrows
    below `NECK_MAX_FRAC_OF_HEAD` of the head width, the local minimum of
    that valley is the neck — provided a rise (shoulders/torso) follows.
    Taking the *first* valley (not the global minimum of a wide band) is
    what rejects the hoodie-on-hips failure: a waist pinch lower down is
    never consulted once a real neck valley has been found.
    """
    spans = opaque_spans(frame)
    widths = _smooth(_widths(spans), radius=1)
    h = len(widths)
    if h < 8:
        raise SystemExit("frame too small for structure neck detection")

    top = next((y for y, w in enumerate(widths) if w > 0), None)
    if top is None:
        raise SystemExit("empty frame — no opaque rows")

    head_hi = max(top + 2, int(h * 0.50))
    head_peak = max(range(top, head_hi), key=lambda y: widths[y])
    head_w = widths[head_peak]
    if head_w <= 0:
        raise SystemExit("head peak has zero width")

    threshold = head_w * NECK_MAX_FRAC_OF_HEAD
    # Enter the first pinch zone below the head.
    enter = None
    for y in range(head_peak + 1, int(h * 0.80)):
        if widths[y] <= threshold:
            enter = y
            break
    if enter is None:
        raise SystemExit(
            f"no neck pinch below head@{head_peak} (head width {head_w:.0f}; "
            f"silhouette never narrowed below {threshold:.0f}) — "
            f"hoodie-class failure; set order.neckAnchors"
        )

    # Local minimum of this valley: keep walking while width stays low /
    # still falling, stop once it has risen clearly (torso begins).
    neck_y = enter
    y = enter
    while y + 1 < int(h * 0.85):
        y += 1
        if widths[y] < widths[neck_y]:
            neck_y = y
        # Left the valley: width has risen by ≥25% of the pinch depth.
        elif widths[y] >= widths[neck_y] + max(2.0, (threshold - widths[neck_y]) * 0.25):
            # Confirm the rise persists one more row (noise guard).
            if y + 1 < h and widths[y + 1] >= widths[neck_y]:
                break
    # Must actually be a pinch, not a flat.
    if widths[neck_y] > threshold:
        raise SystemExit(
            f"neck candidate @{neck_y} width {widths[neck_y]:.0f} exceeds pinch threshold"
        )
    # Must sit above the lower torso. High-res walk frames land near 0.70 of
    # height with a real neck (chin bob); only reject clear hip minima.
    if neck_y > int(h * 0.78):
        raise SystemExit(
            f"structure neck landed too low (y={neck_y}/{h}) — waist/hip minimum"
        )
    span_row = spans[neck_y]
    assert span_row is not None
    x0, x1 = span_row
    return ((x0 + x1) // 2, neck_y)


def structure_hand_carry(frame: Image.Image) -> tuple[int, int]:
    """Carry hand ≈ center of the waist silhouette's widest row (mitten pad).

    Facing-right carry art puts a round mitten in front of the waist; that
    pad widens the opaque span at belt height. The item rest point is the
    horizontal center of the peak-width row in the waist band — measured to
    match avatar.boy-basic-carry's (26,64) / red-carry's (23,64) within a
    couple of pixels, without skin-color heuristics.

    (An earlier rightmost-protrusion flood fill landed on the waist-band
    ceiling / neck row for every sheet, because the bent arm connects into
    the shoulder silhouette.)
    """
    spans = opaque_spans(frame)
    h = frame.size[1]
    # Stay above the crotch/stride flare: wide walk contacts otherwise win
    # the peak-width search and park the item on a thigh.
    waist_lo, waist_hi = int(h * 0.55), int(h * 0.70)
    candidates = [
        (y, spans[y][1] - spans[y][0], spans[y])
        for y in range(waist_lo, waist_hi)
        if spans[y] is not None
    ]
    if not candidates:
        raise SystemExit("no opaque rows in the carry waist band")
    peak_y, peak_w, peak_span = max(candidates, key=lambda t: t[1])
    if peak_w < 8:
        raise SystemExit("carry waist span too narrow to be a mitten pad")
    x0, x1 = peak_span
    return ((x0 + x1) // 2, peak_y)
