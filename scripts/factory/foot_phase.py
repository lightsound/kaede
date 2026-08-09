"""Walk-cycle frame selection by foot-position structure analysis.

The ①b(c) bench hardcoded video frame indices (n66/n72/n78/n84). That works
for one clip; a factory that runs many characters needs to pick contact and
passing poses from whatever phase the video model starts on. This module
reads a directory of extracted PNG frames (already chroma-ready or raw),
measures which foot is forward from the silhouette, finds one stride period,
and returns four indices: contact-A, pass-A, contact-B, pass-B.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image

OPAQUE = 128
# Green dominance for optional in-place keying of video frames that still
# carry a soft ground shadow (wan adds one despite the prompt).
KEY_HARD = 40


def _is_content(r: int, g: int, b: int, a: int) -> bool:
    if a < OPAQUE:
        return False
    return (g - max(r, b)) < KEY_HARD


def foot_signal(frame: Image.Image) -> float:
    """Signed stride phase from the feet band's center of mass.

    Bottom 30% of the character bbox: the mass-weighted mean x, minus the
    body midpoint. Contact poses with a foot stretched forward pull the
    mean to one side; passing poses keep it near zero. Sign convention is
    arbitrary (facing-right art → positive when the image-right foot leads)
    — the factory only needs a clean oscillation to find extrema.
    """
    px = frame.convert("RGBA").load()
    w, h = frame.size
    content = [
        (x, y)
        for y in range(h)
        for x in range(w)
        if _is_content(*px[x, y])
    ]
    if len(content) < 30:
        return 0.0
    xs = [x for x, _ in content]
    ys = [y for _, y in content]
    x0, x1 = min(xs), max(xs)
    y0, y1 = min(ys), max(ys)
    mid_x = (x0 + x1) / 2
    foot_y0 = y0 + int((y1 - y0) * 0.70)
    feet = [(x, y) for x, y in content if y >= foot_y0]
    if len(feet) < 8:
        return 0.0
    # Weight lower pixels more (planted foot > raised foot).
    weight_sum = sum((y - foot_y0 + 1) for _, y in feet)
    mean_x = sum(x * (y - foot_y0 + 1) for x, y in feet) / weight_sum
    return float(mean_x - mid_x)


def load_signals(frame_paths: list[Path]) -> list[float]:
    return [foot_signal(Image.open(p)) for p in frame_paths]


def _find_period(signals: list[float], min_period: int, max_period: int) -> int:
    """Autocorrelation peak of the foot-forward signal = one stride."""
    n = len(signals)
    mean = sum(signals) / n
    centered = [s - mean for s in signals]
    best_lag, best_score = min_period, float("-inf")
    for lag in range(min_period, min(max_period, n // 2) + 1):
        score = sum(centered[i] * centered[i + lag] for i in range(n - lag))
        if score > best_score:
            best_score, best_lag = score, lag
    return best_lag


def select_walk_indices(
    frame_paths: list[Path],
    *,
    fps: float = 30.0,
    skip_head_seconds: float = 1.5,
) -> dict[str, int]:
    """Pick walk-a..d frame indices from an extracted walk clip.

    Skips the first `skip_head_seconds` (wan often eases into the stride),
    finds one period, and inside a stable window returns:
      walk-a: max positive foot signal (near/right contact)
      walk-b: zero-crossing after a (passing)
      walk-c: max negative foot signal (opposite contact)
      walk-d: zero-crossing after c (opposite passing)
    """
    if len(frame_paths) < 16:
        raise SystemExit(f"need ≥16 frames for phase selection, got {len(frame_paths)}")
    signals = load_signals(frame_paths)
    start = min(len(signals) - 8, int(skip_head_seconds * fps))
    window = signals[start:]
    # One stride is ~0.4–0.8s at game cadence; at 30fps that is 12–24 frames.
    period = _find_period(window, min_period=10, max_period=28)
    # Prefer a window in the middle of the clip (avoid ease-in/out).
    mid = start + len(window) // 2
    lo = max(start, mid - period)
    hi = min(len(signals), lo + period)
    segment = list(enumerate(signals))[lo:hi]
    if len(segment) < 8:
        raise SystemExit("stride window too short after skip")

    idx_max = max(segment, key=lambda iv: iv[1])[0]
    idx_min = min(segment, key=lambda iv: iv[1])[0]

    def nearest_zero_after(origin: int, toward: int) -> int:
        step = 1 if toward >= origin else -1
        best_i, best_abs = origin, abs(signals[origin])
        i = origin
        while i != toward:
            i += step
            if abs(signals[i]) < best_abs:
                best_abs, best_i = abs(signals[i]), i
        return best_i

    # Order contacts so walk-a is the first contact in temporal order, then
    # the passing toward the opposite contact, then that contact, then the
    # return passing — matching the boy-basic committed cycle.
    first, second = (idx_max, idx_min) if idx_max < idx_min else (idx_min, idx_max)
    pass_ab = nearest_zero_after(first, second)
    # Passing back: from second toward first+period (wrap inside segment).
    end = hi - 1
    pass_cd = nearest_zero_after(second, end if second < end else lo)
    # Assign by sign: positive tip → walk-a family.
    if signals[first] >= 0:
        a, c = first, second
        b, d = pass_ab, pass_cd
    else:
        a, c = second, first
        b, d = pass_cd, pass_ab
    chosen = {"walk-a": a, "walk-b": b, "walk-c": c, "walk-d": d}
    if len(set(chosen.values())) < 4:
        # Degenerate clip — fall back to equal spacing inside the period.
        base = lo
        chosen = {
            "walk-a": base,
            "walk-b": base + period // 4,
            "walk-c": base + period // 2,
            "walk-d": base + (3 * period) // 4,
        }
    return chosen


def select_walk_paths(frame_dir: Path, **kwargs: float) -> dict[str, Path]:
    """Convenience: sorted `frame_NNNN.png` in a directory → pose→path map."""
    frames = sorted(frame_dir.glob("frame_*.png"))
    if not frames:
        frames = sorted(frame_dir.glob("*.png"))
    indices = select_walk_indices(frames, **kwargs)  # type: ignore[arg-type]
    return {pose: frames[i] for pose, i in indices.items()}
