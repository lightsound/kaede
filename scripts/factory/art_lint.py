"""Art lint for imported avatar sheets (asset-pipeline.md §3-3).

Checks run after import (or dry against an existing outDir). Failures exit
non-zero so the factory line refuses to commit a out-of-spec sheet.

Anchor divergence uses structure-based detection (anchors.py) — never skin
color — closing the three ①b(a)⑵ holes (hoodie neck, beige contamination,
and the need for order overrides to be validated rather than trusted blind).

Palette contrast compares the sheet's dominant colors to a base outfit's
committed palette (default avatar.boy-basic) so white-on-white items/clothes
fail loud at import time instead of at game-scale review.
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

from PIL import Image

# scripts/ on sys.path when run as a module from repo root.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from factory.anchors import HairReference, structure_neck  # noqa: E402

OPAQUE = 128
# 2x-resolution pixels. A 4px miss at source = 2 logical px on screen.
NECK_DIVERGENCE_PX = 10
# Euclidean RGB distance; white (#ffffff) vs near-white shirt fails below ~40.
MIN_PALETTE_DISTANCE = 35
STAND_HEIGHT_RANGE = (88, 104)  # standHeightPx target 96 ± slack
# Carry mitten rests in front of the waist (not out at the silhouette edge —
# the arm is bent across the torso). Structural presence = opaque pixel in
# the waist band; skin-tone is never consulted (beige-clothes hole).
HAND_WAIST_BAND = (0.50, 0.85)

# Head-consistency gates (vs the stand frame). The head composite makes every
# frame's head pixel-identical to the stand's, so any excess above-neck mass
# is a compositing/detection failure. Calibrated 2026-08-09 on the four
# committed sheets (pass: neck row Δ ≤ 1, head-pixel ratio 0.99–1.01) against
# the PR #94 rejects (fail: double head Δ+19 / ratio 1.61; bob-hair remnants
# behind the pasted head ratio 1.07–1.08).
HEAD_NECK_ROW_DELTA_MAX = 3
HEAD_WIDTH_RATIO_MAX = 1.05
HEAD_PIXEL_RATIO_RANGE = (0.90, 1.05)

# Leg-phase gate for swing (non-carry) walk cycles, calibrated on the
# approved boy sheets vs the owner-rejected girl cycles (2026-08-09 round 3):
# no two walk frames may be near-clones. The owner-caught failure shapes —
# the one-foot shuffle (contacts that never trade legs) and the missing
# stride midpoint — both manifest as a near-clone pair (rejected girl
# contact pair IoU 0.92-0.97; approved sheets peak at 0.87, the boy master
# cycle at 0.85). A foot-band-signal "opposite signs / wide spread" test
# was tried twice and retired (2026-08-12): opposite contacts of a side-view
# chibi are near-mirror silhouettes, so the signal's left/right separation is
# a rendering accident — the committed boy's renders spread 5.2 while the
# boy MASTER's genuine opposite contacts (verified by eye) spread 0.3, below
# any line that still catches the rejected shuffle (2.2). Carry sheets
# stride gently with near-static legs by spec and are excluded from this
# gate (the run_lint rule).
WALK_A_D_IOU_MAX = 0.90
# body every frame; a walk frame must not grow a significant INTERIOR color
# far from everything in the stand (interior_only — see
# _significant_colors). Calibrated 2026-08-09: every committed sheet's
# interior drift ≤ 38, while wan repainting the girl's sky-blue camisole
# gray measured 57–58 on two takes (solid interior clusters — caught and
# retaken). Subtler same-hue limb-tone shifts (the PR #94 pink limbs, ≤ 29)
# sit below any threshold that keeps shipped sheets passing; those remain
# the visual gate's job.
DRIFT_DISTANCE_MAX = 45
DRIFT_MIN_SHARE = 0.04
DRIFT_STAND_MIN_SHARE = 0.01


def _dist(a: tuple[int, int, int], b: tuple[int, int, int]) -> float:
    return math.sqrt(sum((x - y) ** 2 for x, y in zip(a, b)))


def _parse_hex(color: str) -> tuple[int, int, int]:
    c = color.lstrip("#")
    return (int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16))


def chroma_residue_ratio(frame: Image.Image) -> float:
    """Fraction of opaque-ish pixels that are still green-dominant."""
    total = kept = 0
    for r, g, b, a in frame.convert("RGBA").getdata():
        if a < 16:
            continue
        total += 1
        if g - max(r, b) >= 40:
            kept += 1
    return kept / total if total else 0.0


def _head_stats(frame: Image.Image, neck_y: int) -> tuple[int, int]:
    """(max opaque row width, opaque pixel count) of the above-neck band."""
    alpha = frame.getchannel("A").load()
    w = frame.width
    max_width = pixels = 0
    for y in range(max(0, min(neck_y, frame.height))):
        xs = [x for x in range(w) if alpha[x, y] >= OPAQUE]
        if xs:
            max_width = max(max_width, xs[-1] - xs[0] + 1)
            pixels += len(xs)
    return max_width, pixels


def _significant_colors(
    frame: Image.Image, min_share: float, *, interior_only: bool = False
) -> list[tuple[int, int, int]]:
    """Dominant opaque colors holding at least `min_share` of the pixels.

    With `interior_only`, boundary pixels — next to transparency or to a
    strongly different quantized color — are excluded before shares are
    computed. High-contrast art (near-black bob over pale skin) produces
    antialiasing-blend clusters that hold 4%+ of the OUTLINE pixels and vary
    with the pose; they are drawing artifacts, not repainted regions
    (measured 98–100% boundary on the girl's flagged clusters, 2026-08-09).
    A genuinely repainted region is solid, so its interior mass survives.
    """
    quantized = frame.convert("RGB").quantize(colors=16).convert("RGB")
    colors = quantized.load()
    alpha = frame.getchannel("A").load()
    w, h = frame.size

    def opaque(x: int, y: int) -> bool:
        return 0 <= x < w and 0 <= y < h and alpha[x, y] >= OPAQUE

    def interior(x: int, y: int) -> bool:
        # Radius-2 erosion: antialiasing blend bands on high-contrast art
        # (black bob against skin/sky-blue) are 2–3px wide, and a 1-ring
        # test still let their quantized clusters reach the 4% share floor
        # on some frames (false drift on a visually clean frame, measured
        # 2026-08-10). Genuinely repainted regions are solid and survive.
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1), (2, 0), (-2, 0), (0, 2), (0, -2)):
            if not opaque(x + dx, y + dy):
                return False
            if _dist(colors[x + dx, y + dy], colors[x, y]) > 60:
                return False
        return True

    counts: dict[tuple[int, int, int], int] = {}
    total = 0
    for y in range(h):
        for x in range(w):
            if not opaque(x, y):
                continue
            if interior_only and not interior(x, y):
                continue
            counts[colors[x, y]] = counts.get(colors[x, y], 0) + 1
            total += 1
    if total == 0:
        return []
    return [c for c, n in counts.items() if n / total >= min_share]


def check_head_consistency(
    stand: Image.Image, stand_neck_y: int, frame: Image.Image, neck_y: int
) -> list[str]:
    """The composited head must be the stand head — nothing more.

    Catches the two PR #94 failure shapes: a second head stacked by a
    misdetected neck (pixel ratio 1.61) and video-drawn hair peeking out
    behind the pasted head (ratio 1.07+ on the bob haircut).
    """
    failures: list[str] = []
    delta = abs(neck_y - stand_neck_y)
    if delta > HEAD_NECK_ROW_DELTA_MAX:
        failures.append(
            f"neck row drifted {delta}px from stand (> {HEAD_NECK_ROW_DELTA_MAX}) "
            f"— head composite landed on a misdetected neck"
        )
    stand_width, stand_pixels = _head_stats(stand, stand_neck_y)
    width, pixels = _head_stats(frame, neck_y)
    if stand_width == 0 or stand_pixels == 0:
        return [*failures, "stand has no above-neck content to compare against"]
    if width / stand_width > HEAD_WIDTH_RATIO_MAX:
        failures.append(
            f"head width {width}px is {width / stand_width:.2f}x the stand's "
            f"(> {HEAD_WIDTH_RATIO_MAX}) — residual video hair behind the composite"
        )
    ratio = pixels / stand_pixels
    lo, hi = HEAD_PIXEL_RATIO_RANGE
    if not lo <= ratio <= hi:
        failures.append(
            f"head pixel mass {ratio:.2f}x the stand's (outside [{lo}, {hi}]) "
            f"— double head or clipped composite"
        )
    return failures


def silhouette_iou(a: Image.Image, b: Image.Image) -> float:
    """Alpha-mask IoU of two frames aligned bottom-center (the ground rule).

    The outfit-edit lane's pose-fidelity gate: a keep-everything edit keeps
    poses (the red hoodie measured 0.916–0.956; residue is the garment's own
    silhouette), while a pose regression to one stride drops a contact frame
    well below that. Alignment matches the renderer: feet on the ground,
    horizontally centered.
    """
    width = max(a.width, b.width)
    height = max(a.height, b.height)

    def mask(img: Image.Image) -> list[bool]:
        canvas = Image.new("L", (width, height), 0)
        canvas.paste(
            img.getchannel("A").point(lambda v: 255 if v >= OPAQUE else 0),
            ((width - img.width) // 2, height - img.height),
        )
        return [v >= OPAQUE for v in canvas.getdata()]

    mask_a, mask_b = mask(a), mask(b)
    union = sum(1 for x, y in zip(mask_a, mask_b) if x or y)
    if union == 0:
        return 0.0
    intersection = sum(1 for x, y in zip(mask_a, mask_b) if x and y)
    return intersection / union


def check_leg_phase(frames: dict[str, Image.Image]) -> list[str]:
    """Swing-walk cycle sanity: every walk frame must be a distinct pose.

    The owner-facing failure shapes this encodes (both shipped past every
    other gate before being caught by eye): contacts whose legs never trade
    (one-foot shuffle) and a walk-d so close to walk-a that the second half
    of the stride has no midpoint — both read as near-clone frame pairs.
    """
    required = {"walk-a", "walk-b", "walk-c", "walk-d"}
    if not required <= frames.keys():
        return []
    failures: list[str] = []
    # No pair of walk frames may be near-clones. Calibrated: the approved
    # swing sheets peak at IoU(b,d) 0.87; a same-leg contact pair measured
    # 0.97 and a scrambled substitution's (b,c) measured 0.95 — both read
    # as skipped/missing midpoints at play speed.
    walk_names = [n for n in ("walk-a", "walk-b", "walk-c", "walk-d") if n in frames]
    for i, first in enumerate(walk_names):
        for second in walk_names[i + 1 :]:
            iou = silhouette_iou(frames[first], frames[second])
            if iou > WALK_A_D_IOU_MAX:
                failures.append(
                    f"{first} and {second} are near-clones (IoU {iou:.2f} > "
                    f"{WALK_A_D_IOU_MAX}) — a stride midpoint is missing"
                )
    return failures


# Neck-junction gates for walk cells (①d 論点 6 — the girl neck-break
# reproduction, 2026-08-12). The junction is judged row by row over the band
# around the recorded neck anchor, WINDOWED to the anchor column ±5px: a
# first cut measured the whole contiguous alpha run instead and could not be
# calibrated — the bob's anti-aliased bottom edge merges into the junction
# row's run, so every girl-with-bob composite (healthy ones included, the
# master-lane candidates measured 2026-08-12) scored like the rejects. Two
# windowed signals, calibrated on the committed sheets:
# - effective alpha width (Σα/255 over the window): the owner-rejected girl
#   walk-c junction measures 2.0 — a literal head-body gap, THE break the
#   owner saw flicker at play speed. Healthy committed cells measure ≥ 7.3.
# - soft/solid ratio (soft = alpha 64..229, solid = alpha ≥ 230) of the worst
#   band row: every committed healthy cell ≤ 0.83; a translucent-core bridge
#   has no solid pixels at all, so it measures the raw soft count (≥ 5). The
#   self-masked-paste alpha-squared decay (bench_head_swap: α186 core → 135)
#   produces exactly that shape, so this gate also enforces the
#   alpha_composite rule end to end.
# Stand cells are exempt: the junction flicker is a play-speed artifact of
# the walk cycle, and the committed stands are the identity anchors every
# other lane measures against.
JUNCTION_BAND = (-4, 2)
JUNCTION_WINDOW = 5
JUNCTION_SOFT_ALPHA = 64
JUNCTION_SOLID_ALPHA = 230
JUNCTION_SOFT_RATIO_MAX = 1.5
JUNCTION_WIDTH_MIN = 3.0


def check_neck_junction(frame: Image.Image, neck: list[int]) -> list[str]:
    """The head-body junction must be an opaque bridge, not a translucent one."""
    alpha = frame.getchannel("A").load()
    nx, ny = neck
    if not 0 <= nx < frame.width:
        return [f"neck anchor x={nx} outside the frame"]
    failures: list[str] = []
    for y in range(max(0, ny + JUNCTION_BAND[0]), min(frame.height, ny + JUNCTION_BAND[1] + 1)):
        window = [
            alpha[x, y]
            for x in range(max(0, nx - JUNCTION_WINDOW), min(frame.width, nx + JUNCTION_WINDOW + 1))
        ]
        effective = sum(window) / 255.0
        solid = sum(1 for a in window if a >= JUNCTION_SOLID_ALPHA)
        soft = sum(1 for a in window if JUNCTION_SOFT_ALPHA <= a < JUNCTION_SOLID_ALPHA)
        if effective < JUNCTION_WIDTH_MIN:
            failures.append(
                f"neck junction row {y} is a gap (effective width "
                f"{effective:.1f}px < {JUNCTION_WIDTH_MIN}) — head disconnects "
                f"from the body at the anchor column"
            )
        elif soft / max(solid, 1) > JUNCTION_SOFT_RATIO_MAX:
            failures.append(
                f"neck junction row {y} is a semi-transparent bridge "
                f"(soft/solid {soft}/{solid} > {JUNCTION_SOFT_RATIO_MAX}) — "
                f"reads as a neck break at play speed"
            )
    return failures


# Hair-blob scale verification tolerance, on sqrt(pixel count). Generative
# takes redraw the hair slightly (the wave take grew it ~9% linear —
# measured), so the tolerance is looser than a resize error would need but
# far tighter than the 1.42x/2x canvas-scale mistakes it exists to catch.
HAIR_SCALE_TOLERANCE = 0.15


def check_gesture_cell(
    reference: HairReference,
    import_scale: float,
    pose: str,
    cell: Image.Image,
) -> tuple[list[str], list[int]]:
    """(failures, neck anchor) — one cell of the gesture lanes' compose gate.

    Shared by compose_gesture_sheet and the fal replace lane, driven by the
    stand's HairReference (factory.anchors): hair-blob scale verification
    against the stand, the calibrated palette-drift check, and the
    hair-blob neck estimate (the head is rigid, so its depth below the
    hair top is the stand's), persisted in imported-frame coordinates.
    """
    from factory.anchors import hair_stats

    cx, top, hair_scale = hair_stats(cell, reference.mean)
    ratio = hair_scale / reference.scale
    print(f"{pose}: hair scale ratio {ratio:.3f}")
    failures: list[str] = []
    if abs(ratio - 1.0) > HAIR_SCALE_TOLERANCE:
        failures.append(
            f"{pose}: hair scale ratio {ratio:.3f} — scale normalization broke"
        )
    failures += [f"{pose}: {f}" for f in check_palette_drift(reference.stand, cell)]
    neck = [
        round(cx * import_scale),
        round((top + reference.head_depth) * import_scale),
    ]
    return failures, neck


def check_palette_drift(stand: Image.Image, frame: Image.Image) -> list[str]:
    """No significant frame color may sit far from every stand color.

    Deliberately has NO suppression hook: an acknowledged-colors exemption
    existed for one day and its only use — the agent judging an off-palette
    under-chin shadow "visually clean" — was owner-rejected (2026-08-10,
    目視では影がおかしい). The calibrated gate outranks the operator's eye;
    a frame that fails must be replaced, not excused.
    """
    stand_colors = _significant_colors(stand, DRIFT_STAND_MIN_SHARE)
    if not stand_colors:
        return ["stand has no significant colors to compare against"]
    failures = []
    for color in _significant_colors(frame, DRIFT_MIN_SHARE, interior_only=True):
        nearest = min(_dist(color, sc) for sc in stand_colors)
        if nearest > DRIFT_DISTANCE_MAX:
            failures.append(
                f"color #{color[0]:02x}{color[1]:02x}{color[2]:02x} drifted "
                f"{nearest:.0f} from the stand palette (> {DRIFT_DISTANCE_MAX}) "
                f"— video model repainted limbs/shoes"
            )
    return failures


def lint_avatar(
    manifest_path: Path,
    *,
    base_palette: list[str] | None = None,
    expect_carry_hand: bool = False,
    expect_leg_phase: bool = False,
) -> list[str]:
    """Return a list of human-readable failures (empty = pass)."""
    manifest = json.loads(manifest_path.read_text())
    base = manifest_path.parent
    failures: list[str] = []
    poses = manifest.get("poses") or {}
    if "stand" not in poses:
        failures.append("missing stand pose")
        return failures

    stand = poses["stand"]
    stand_h = stand["size"][1]
    if not STAND_HEIGHT_RANGE[0] <= stand_h <= STAND_HEIGHT_RANGE[1]:
        failures.append(
            f"stand height {stand_h}px outside {STAND_HEIGHT_RANGE} "
            f"(target standHeightPx≈96)"
        )

    stand_path = base / stand["file"]
    stand_frame = (
        Image.open(stand_path).convert("RGBA") if stand_path.is_file() else None
    )
    stand_neck = stand.get("anchors", {}).get("neck")

    loaded: dict[str, Image.Image] = {}
    for name, pose in poses.items():
        frame_path = base / pose["file"]
        if not frame_path.is_file():
            failures.append(f"{name}: missing file {pose['file']}")
            continue
        frame = Image.open(frame_path).convert("RGBA")
        loaded[name] = frame
        residue = chroma_residue_ratio(frame)
        if residue > 0.01:
            failures.append(f"{name}: chroma residue {residue:.2%} > 1%")

        if name != "stand" and stand_frame is not None:
            recorded = pose.get("anchors", {}).get("neck")
            if stand_neck and recorded:
                failures += [
                    f"{name}: {f}"
                    for f in check_head_consistency(
                        stand_frame, stand_neck[1], frame, recorded[1]
                    )
                ]
            failures += [
                f"{name}: {f}" for f in check_palette_drift(stand_frame, frame)
            ]

        recorded_neck = pose.get("anchors", {}).get("neck")
        if name.startswith("walk") and recorded_neck:
            failures += [
                f"{name}: {f}" for f in check_neck_junction(frame, recorded_neck)
            ]
        try:
            detected_neck = list(structure_neck(frame))
        except SystemExit as exc:
            failures.append(f"{name}: structure neck failed — {exc}")
            detected_neck = None
        if recorded_neck and detected_neck:
            d = math.dist(recorded_neck, detected_neck)
            if d > NECK_DIVERGENCE_PX:
                failures.append(
                    f"{name}: neck divergence {d:.1f}px "
                    f"(recorded {recorded_neck}, structure {detected_neck}) "
                    f"> {NECK_DIVERGENCE_PX}"
                )

        if expect_carry_hand or (name == "stand" and manifest.get("handLayer")):
            recorded_hand = pose.get("anchors", {}).get("hand")
            if recorded_hand:
                hx, hy = recorded_hand
                lo = int(frame.height * HAND_WAIST_BAND[0])
                hi = int(frame.height * HAND_WAIST_BAND[1])
                if not (0 <= hx < frame.width and 0 <= hy < frame.height):
                    failures.append(f"{name}: hand anchor out of frame {recorded_hand}")
                elif not (lo <= hy < hi):
                    failures.append(
                        f"{name}: hand y={hy} outside waist band [{lo},{hi}) "
                        f"— carry mitten must sit at the waist (not chest/hips)"
                    )
                elif frame.getpixel((hx, hy))[3] < OPAQUE:
                    failures.append(
                        f"{name}: hand anchor {recorded_hand} is transparent "
                        f"(not on the mitten — structural presence check)"
                    )

    if expect_leg_phase:
        failures += check_leg_phase(loaded)

    if base_palette:
        sheet_palette = [_parse_hex(c) for c in manifest.get("palette", [])]
        base_colors = [_parse_hex(c) for c in base_palette]
        if sheet_palette and base_colors:
            # Best (minimum) distance from each sheet color to the base set;
            # the sheet must have at least one color that clearly contrasts.
            best = max(
                min(_dist(sc, bc) for bc in base_colors) for sc in sheet_palette
            )
            if best < MIN_PALETTE_DISTANCE:
                failures.append(
                    f"palette contrast {best:.1f} < {MIN_PALETTE_DISTANCE} "
                    f"vs base outfit (sheet may disappear on the default clothes)"
                )

    return failures


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("usage: art_lint.py <manifest.json> [--base-palette-manifest PATH]")
    manifest_path = Path(sys.argv[1])
    base_palette = None
    if "--base-palette-manifest" in sys.argv:
        bp = Path(sys.argv[sys.argv.index("--base-palette-manifest") + 1])
        base_palette = json.loads(bp.read_text()).get("palette")
    expect_carry = "--carry" in sys.argv
    failures = lint_avatar(
        manifest_path, base_palette=base_palette, expect_carry_hand=expect_carry
    )
    if failures:
        print("ART LINT FAIL", file=sys.stderr)
        for f in failures:
            print(f"  - {f}", file=sys.stderr)
        raise SystemExit(1)
    print("ART LINT PASS")


if __name__ == "__main__":
    main()
