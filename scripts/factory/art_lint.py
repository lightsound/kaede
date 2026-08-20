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
# 4x-resolution pixels (factory v2 手順 1 — shipping moved 2x/96px → 4x/192px;
# every px-length constant here doubled with it, same logical tolerance).
# A 8px miss at source = 2 logical px on screen.
NECK_DIVERGENCE_PX = 20
# Euclidean RGB distance; white (#ffffff) vs near-white shirt fails below ~40.
MIN_PALETTE_DISTANCE = 35
STAND_HEIGHT_RANGE = (176, 208)  # standHeightPx target 192 ± slack
# Carry mitten rests in front of the waist (not out at the silhouette edge —
# the arm is bent across the torso). Structural presence = opaque pixel in
# the waist band; skin-tone is never consulted (beige-clothes hole).
HAND_WAIST_BAND = (0.50, 0.85)

# Head-consistency gates (vs the stand frame). The head composite makes every
# frame's head pixel-identical to the stand's, so any excess above-neck mass
# is a compositing/detection failure. Calibrated 2026-08-09 on the four
# committed sheets (pass: neck row Δ ≤ 1, head-pixel ratio 0.99–1.01) against
# the PR #94 rejects (fail: double head Δ+19 / ratio 1.61; bob-hair remnants
# behind the pasted head ratio 1.07–1.08). Row delta doubled with the 4x
# shipping scale (ratios are scale-free).
HEAD_NECK_ROW_DELTA_MAX = 6
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
# Dense-sheet (A-3, >4 walk cells) calibrations — see check_leg_phase:
# passing×passing quarter pairs are mirror poses (silhouette-blind, 知見 20)
# and cap at the 4-cell scramble level; adjacent cells must not be frozen
# repeats. The 4-cell gates keep their exact original thresholds.
PASSING_CLONE_IOU_MAX = 0.95
ADJACENT_CLONE_IOU_MAX = 0.97
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


def quarter_walk_poses(walk_names: list[str]) -> list[str]:
    """The four quarter-phase cells of a walk vocabulary in stride order:
    contact, passing, mirrored contact, mirrored passing. For the legacy
    4-cell sheets this is the whole vocabulary; for the dense sheets (A-3,
    12 cells) it samples indices 0 / n/4 / n/2 / 3n/4 — the same phases
    the 4-cell era shipped, so the 4-cell calibrations carry over."""
    n = len(walk_names)
    if n < 4:
        return walk_names
    return [walk_names[(k * n) // 4] for k in range(4)]


def check_leg_phase(frames: dict[str, Image.Image]) -> list[str]:
    """Swing-walk cycle sanity: the stride's quarter-phase poses must be
    distinct.

    The owner-facing failure shapes this encodes (both shipped past every
    other gate before being caught by eye): contacts whose legs never trade
    (one-foot shuffle) and a final passing so close to the first contact
    that the second half of the stride has no midpoint — both read as
    near-clone frame pairs. On dense sheets (A-3) only the QUARTER cells
    are compared: adjacent frames of a 12-cell cycle are similar by
    construction, and the collapse this gate exists to catch shows up as
    quarter-phase clones exactly as it did at 4 cells.
    """
    walk_names = sorted(n for n in frames if n.startswith("walk-"))
    if len(walk_names) < 4:
        return []
    failures: list[str] = []
    dense = len(walk_names) > 4
    # No pair of quarter cells may be near-clones. Calibrated: the approved
    # swing sheets peak at IoU(b,d) 0.87; a same-leg contact pair measured
    # 0.97 and a scrambled substitution's (b,c) measured 0.95 — both read
    # as skipped/missing midpoints at play speed.
    #
    # Dense-sheet calibration (A-3, 12 cells): the PASSING×PASSING pair is
    # capped at the scramble level (0.95) instead of 0.90 — the two passing
    # phases of a bone-verified two-step gait (antiphase 1.0) are mirror
    # poses that a 3/4 silhouette cannot tell apart (知見 20), and the wan
    # generation's gentle arm swing measures them at 0.92-0.93 (the A-3
    # boy re-cast) while the frames are genuinely distinct in RGB. The
    # 4-cell failure this guarded — the one-beat stutter of near-clone
    # passings — is structurally gone at 12 cells (the 24→12 carry
    # preview measurement); contacts and mixed pairs keep the 0.90 cap.
    quarters = quarter_walk_poses(walk_names)
    passing_pair = {quarters[1], quarters[3]}
    for i, first in enumerate(quarters):
        for second in quarters[i + 1 :]:
            cap = (
                PASSING_CLONE_IOU_MAX
                if dense and {first, second} == passing_pair
                else WALK_A_D_IOU_MAX
            )
            iou = silhouette_iou(frames[first], frames[second])
            if iou > cap:
                failures.append(
                    f"{first} and {second} are near-clones (IoU {iou:.2f} > "
                    f"{cap}) — a stride midpoint is missing"
                )
    if dense:
        # Frozen-frame detector: adjacent dense cells are similar by
        # construction but never IDENTICAL — a stuck extraction repeats a
        # frame (IoU ~1.0), which plays as a hitch.
        ordered = [*walk_names, walk_names[0]]
        for first, second in zip(ordered, ordered[1:]):
            iou = silhouette_iou(frames[first], frames[second])
            if iou > ADJACENT_CLONE_IOU_MAX:
                failures.append(
                    f"{first} and {second} (adjacent) are identical (IoU "
                    f"{iou:.2f} > {ADJACENT_CLONE_IOU_MAX}) — a frozen/"
                    f"repeated frame"
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
# Px lengths (band, window, effective width) doubled with the 4x shipping
# scale; the soft/solid ratio is scale-free (soft and solid pixels widen
# together under LANCZOS from the same source).
JUNCTION_BAND = (-8, 4)
JUNCTION_WINDOW = 10
JUNCTION_SOFT_ALPHA = 64
JUNCTION_SOLID_ALPHA = 230
JUNCTION_SOFT_RATIO_MAX = 1.5
JUNCTION_WIDTH_MIN = 6.0


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


# Bob-phase gate (差し戻し② 2026-08-13 — the girl walked with her head
# bobbing OPPOSITE to the boy's, and the carry bounced 7px): the composed
# walk cells' neck-from-ground (frame height − neck row; the frame bottom
# is the ground) must hold the prescribed two-bump pattern — LOW on both
# contact slots (walk-a/c), HIGH on both passings (walk-b/d) — with the
# owner-approved amplitude (the wan-era boy sheet's p-p 3px at the 2x=96px
# sheet scale; the ranges below are px at the 4x=192px shipping scale, so
# the historic measurements read doubled). This is the gate that makes
# NG1/NG2 shapes unshippable: both rejected fix attempts (PR #108:
# 46/46/44/49 @96px, PR #109: 44/48/47/44) fail it, as do the three
# rejected committed families (girl 47/44/45/48, carry 45/51/44/51,
# light 46/48/47/47). Sheets composed before the prescription (the
# one-bump boy base, 46/49/47/47) fail on re-import by design: the fix is
# re-running the walk lane, not exempting the sheet.
BOB_PP_RANGE = (4, 10)
BOB_CONTRAST_MIN = 2.0

# Video-native sheets (2026-08-20「24 で進めて」) carry the master's REAL
# bob, not the prescribed cosine, and physics does not put its extremes
# exactly on the geometric quarters: measured across the three re-extracted
# parents, peak-to-peak came out 4–5px but the quarter contrast was only
# 1–2px (boy walk-g 94 vs walk-m 93). What natural motion does guarantee is
# that contacts sit in the low half of the cycle and passings in the high
# half, and that a real bob exists at all — so the native gate checks the
# full-cycle amplitude band plus contacts ≤ cycle median ≤ passings instead
# of the composite's quarter-contrast rule.
NATIVE_BOB_PP_RANGE = (3, 10)
# Carry sheets stride gently by spec (the same reasoning that exempts them
# from the leg-phase opposition gate): the Texting_Walk master's vertical
# oscillation is small and the forward mitten arms damp it further, so a
# native carry take can land at 2px peak-to-peak at the 192px shipping
# scale (pants-carry t5 measured 2 / parent carry 4 — quantization eats
# the margin). 1px stays "frozen".
NATIVE_BOB_PP_GENTLE_MIN = 2


def check_native_bob(nfg: dict[str, int], *, gentle: bool = False) -> list[str]:
    walk_names = sorted(n for n in nfg if n.startswith("walk-"))
    if len(walk_names) < 4:
        return []
    seq = [nfg[p] for p in walk_names]
    quarters = quarter_walk_poses(walk_names)
    ordered = sorted(seq)
    mid = len(ordered) // 2
    median = (ordered[mid - 1] + ordered[mid]) / 2
    failures: list[str] = []
    contacts = [nfg[quarters[0]], nfg[quarters[2]]]
    passings = [nfg[quarters[1]], nfg[quarters[3]]]
    if max(contacts) > median:
        failures.append(
            f"native bob broken: contact neck heights {contacts} must sit at "
            f"or below the cycle median {median} — the master's own bob "
            f"disagrees with the leg phase; re-run the walk lane"
        )
    if min(passings) < median:
        failures.append(
            f"native bob broken: passing neck heights {passings} must sit at "
            f"or above the cycle median {median} — the master's own bob "
            f"disagrees with the leg phase; re-run the walk lane"
        )
    lo = NATIVE_BOB_PP_GENTLE_MIN if gentle else NATIVE_BOB_PP_RANGE[0]
    pp = max(seq) - min(seq)
    if not lo <= pp <= NATIVE_BOB_PP_RANGE[1]:
        failures.append(
            f"native bob amplitude {pp}px peak-to-peak outside "
            f"({lo}, {NATIVE_BOB_PP_RANGE[1]}) — a frozen head "
            f"(<{lo}) or a seasick bounce (>{NATIVE_BOB_PP_RANGE[1]})"
        )
    return failures


def check_bob_phase(nfg: dict[str, int]) -> list[str]:
    """The head bob must follow the legs — see BOB_PP_RANGE above.

    Judged on the stride's QUARTER cells (contacts at phase 0 and 1/2,
    passings at 1/4 and 3/4 — quarter_walk_poses): identical to the 4-cell
    calibration on legacy sheets, and on dense sheets (A-3) the same four
    phases sampled out of the smooth prescribed cosine (bob_offset_frac),
    whose intermediate cells lie between the extremes by construction.
    """
    walk_names = sorted(n for n in nfg if n.startswith("walk-"))
    if len(walk_names) < 4:
        return []
    quarters = quarter_walk_poses(walk_names)
    bob_contacts = (quarters[0], quarters[2])
    bob_passings = (quarters[1], quarters[3])
    contacts = max(nfg[p] for p in bob_contacts)
    passings = min(nfg[p] for p in bob_passings)
    values = [nfg[p] for p in quarters]
    failures: list[str] = []
    if contacts > passings - BOB_CONTRAST_MIN:
        failures.append(
            f"bob phase broken: contact neck heights "
            f"{[nfg[p] for p in bob_contacts]} must sit ≥{BOB_CONTRAST_MIN}px "
            f"below passing heights {[nfg[p] for p in bob_passings]} — "
            f"re-run the walk lane (prescribed bob), do not hand-edit anchors"
        )
    pp = max(values) - min(values)
    if not BOB_PP_RANGE[0] <= pp <= BOB_PP_RANGE[1]:
        failures.append(
            f"bob amplitude {pp}px peak-to-peak outside {BOB_PP_RANGE} — "
            f"a frozen face (<{BOB_PP_RANGE[0]}) or a seasick bounce "
            f"(>{BOB_PP_RANGE[1]})"
        )
    return failures


# The held-item anchor must land ON drawn hand pixels: the carry v2 sheet
# recorded anchors at the very tip of the outstretched arms, so items
# stood on fingertips beside the face and read as floating (NG3
# 2026-08-13). Skin is only consulted within this radius of an anchor the
# structural checks already accepted — this is not the retired skin-blob
# hand DETECTION (the beige-clothes hole), it validates a recorded
# measurement the way lint.neckFrom validates necks. ±3px at the 2x-era
# calibration, doubled for the 4x=192px shipping scale (a tolerance, not
# a search window — 運転知見 21 の区別).
HAND_SKIN_RADIUS = 6


def _is_skinish(px: tuple[int, int, int, int]) -> bool:
    r, g, b, a = px
    return a >= OPAQUE and r > 200 and 110 < g < 235 and 90 < b < 215 and r > g > b


def check_hand_on_skin(frame: Image.Image, hand: list[int]) -> list[str]:
    hx, hy = hand
    for dy in range(-HAND_SKIN_RADIUS, HAND_SKIN_RADIUS + 1):
        for dx in range(-HAND_SKIN_RADIUS, HAND_SKIN_RADIUS + 1):
            x, y = hx + dx, hy + dy
            if 0 <= x < frame.width and 0 <= y < frame.height and _is_skinish(
                frame.getpixel((x, y))
            ):
                return []
    return [
        f"hand anchor {hand} has no skin within {HAND_SKIN_RADIUS}px — "
        f"the item would ride clothing or empty air, not the drawn hand"
    ]


# Hair-blob scale verification tolerance, on sqrt(pixel count). Generative
# takes redraw the hair slightly (the wave take grew it ~9% linear —
# measured), so the tolerance is looser than a resize error would need but
# far tighter than the 1.42x/2x canvas-scale mistakes it exists to catch.
# Recalibrated 0.15 → 0.18 at the 4x re-import (factory v2 手順 1): the
# sharper 192px stand shrinks the reference blob ~3.5% (girl 170.4 → 164.5
# — fewer edge pixels blend into the hair color), so every ratio shifted
# up ~4% and the owner-approved girl sleep (old yardstick 1.118) measured
# 1.159 on identical source pixels.
HAIR_SCALE_TOLERANCE = 0.18


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


def check_palette_drift(
    stand: Image.Image,
    frame: Image.Image,
    *,
    distance_max: float = DRIFT_DISTANCE_MAX,
) -> list[str]:
    """No significant frame color may sit far from every stand color.

    Deliberately has NO suppression hook: an acknowledged-colors exemption
    existed for one day and its only use — the agent judging an off-palette
    under-chin shadow "visually clean" — was owner-rejected (2026-08-10,
    目視では影がおかしい). The calibrated gate outranks the operator's eye;
    a frame that fails must be replaced, not excused.

    `distance_max` is the 運転知見 37 pattern applied to this gate — an
    ENTRY-scoped, owner-ruled calibration recorded in the order
    (`lint.driftMax`), never a default rewrite. The wan-animate-2 lane
    shades a whole garment a few tones deeper than the seedance-era stand
    it is composed against, so at the 192px gate scale the garment cluster
    sits beyond the default 45 while the art is owner-approved (girl walk
    2026-08-20 PR #128「色については現行でも問題ない」— measured 73–75 on
    both takes, 運転知見 39). The default keeps catching the calibrated
    defect classes for every sheet without an explicit ruling.
    """
    stand_colors = _significant_colors(stand, DRIFT_STAND_MIN_SHARE)
    if not stand_colors:
        return ["stand has no significant colors to compare against"]
    failures = []
    for color in _significant_colors(frame, DRIFT_MIN_SHARE, interior_only=True):
        nearest = min(_dist(color, sc) for sc in stand_colors)
        if nearest > distance_max:
            failures.append(
                f"color #{color[0]:02x}{color[1]:02x}{color[2]:02x} drifted "
                f"{nearest:.0f} from the stand palette (> {distance_max:g}) "
                f"— video model repainted limbs/shoes"
            )
    return failures


def lint_avatar(
    manifest_path: Path,
    *,
    base_palette: list[str] | None = None,
    expect_carry_hand: bool = False,
    expect_leg_phase: bool = False,
    neck_reference: dict[str, list[int]] | None = None,
    drift_distance_max: float = DRIFT_DISTANCE_MAX,
    native_head: bool = False,
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
            f"(target standHeightPx≈192)"
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
            # Video-native sheets (2026-08-20「24 で進めて」) ship the
            # master's own heads: the stand-vs-walk head equality this
            # check enforces exists to catch COMPOSITE failures (double
            # heads, residual hair), and a native head legitimately
            # differs from the nano stand head by a few percent. The
            # per-frame drift/junction gates below still apply.
            if stand_neck and recorded and not native_head:
                failures += [
                    f"{name}: {f}"
                    for f in check_head_consistency(
                        stand_frame, stand_neck[1], frame, recorded[1]
                    )
                ]
            failures += [
                f"{name}: {f}"
                for f in check_palette_drift(
                    stand_frame, frame, distance_max=drift_distance_max
                )
            ]

        recorded_neck = pose.get("anchors", {}).get("neck")
        if name.startswith("walk") and recorded_neck:
            failures += [
                f"{name}: {f}" for f in check_neck_junction(frame, recorded_neck)
            ]
        if neck_reference is not None and name in neck_reference:
            # Hood-class outfits fill the neck pinch and break the width-
            # profile detector (measured 2026-08-12: the red hoodie's walk-c
            # detected 17px low on two independent takes). The recorded
            # anchor is validated against the PAIR body's manifest instead:
            # a keep-everything edit preserves poses by construction, and
            # the sheet-edit IoU gate proves that construction held.
            if recorded_neck:
                d = math.dist(recorded_neck, neck_reference[name])
                if d > NECK_DIVERGENCE_PX:
                    failures.append(
                        f"{name}: neck divergence {d:.1f}px from the pair "
                        f"reference (recorded {recorded_neck}, pair "
                        f"{neck_reference[name]}) > {NECK_DIVERGENCE_PX}"
                    )
        else:
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
                else:
                    failures += [
                        f"{name}: {f}" for f in check_hand_on_skin(frame, recorded_hand)
                    ]

    if expect_leg_phase:
        failures += check_leg_phase(loaded)

    nfg = {
        name: pose["size"][1] - pose["anchors"]["neck"][1]
        for name, pose in poses.items()
        if pose.get("size") and pose.get("anchors", {}).get("neck")
    }
    failures += (
        check_native_bob(nfg, gentle=expect_carry_hand)
        if native_head
        else check_bob_phase(nfg)
    )

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
