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
    # Must sit in the upper-mid of the frame (true necks); a valley found
    # only near the hips means we never saw a real neck.
    if neck_y > int(h * 0.70):
        raise SystemExit(
            f"structure neck landed too low (y={neck_y}/{h}) — waist/hip minimum"
        )
    span_row = spans[neck_y]
    assert span_row is not None
    x0, x1 = span_row
    return ((x0 + x1) // 2, neck_y)


def structure_hand_carry(frame: Image.Image) -> tuple[int, int]:
    """Carry hand ≈ top-center of the near-side waist protrusion (mitten).

    Facing-right art puts the near arm on the image-right of the torso.
    Seeds from the rightmost waist pixel, flood-fills the skin/outline blob
    connected to it inside the waist band, and returns that blob's
    top-center — the item rest point on the mitten pad.
    """
    spans = opaque_spans(frame)
    alpha = frame.getchannel("A").load()
    w, h = frame.size
    waist_lo, waist_hi = int(h * 0.52), int(h * 0.82)
    # Torso midline ≈ center of the narrowest mid-body row (waist of the
    # body proper); the mitten lives to the right of it.
    mid_band = [
        (y, spans[y])
        for y in range(int(h * 0.45), int(h * 0.65))
        if spans[y] is not None
    ]
    if not mid_band:
        raise SystemExit("no mid-body rows for carry hand")
    mid_y, mid_span = min(mid_band, key=lambda ys: ys[1][1] - ys[1][0])
    mid_x = (mid_span[0] + mid_span[1]) // 2

    seed = None
    for y in range(waist_lo, waist_hi):
        span = spans[y]
        if span is None or span[1] <= mid_x:
            continue
        candidate = (span[1], y)
        if seed is None or candidate[0] > seed[0]:
            seed = candidate
    if seed is None:
        raise SystemExit("no near-side protrusion in the waist band")

    # Flood-fill only inside the waist band (do NOT climb into the head —
    # the bent near arm connects through the shoulder silhouette).
    y_min, y_max = waist_lo, waist_hi
    seen: set[tuple[int, int]] = set()
    stack = [seed]
    seen.add(seed)
    while stack:
        x, y = stack.pop()
        for nb in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            nx, ny = nb
            if not (0 <= nx < w and y_min <= ny < y_max):
                continue
            if nb in seen or nx < mid_x + 2:
                continue
            if alpha[nx, ny] < OPAQUE:
                continue
            seen.add(nb)
            stack.append(nb)
    if len(seen) < 8:
        raise SystemExit("carry-hand blob too small to be a mitten")
    top_y = min(y for _, y in seen)
    top_row = [x for x, y in seen if y == top_y]
    return ((min(top_row) + max(top_row)) // 2, top_y)
