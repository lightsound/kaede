"""Compose a 5-cell green-screen pose sheet from stand + walk frames.

Mirrors the post-composition of the ①b(c) adopted line:
1. chroma-key / flatten soft green shadows
2. trim to content, ground feet to cell bottom
3. composite the stand head onto every walk frame at that frame's neck
4. pack into one row on pure #00FF00
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from factory.anchors import structure_neck  # noqa: E402

KEY_HARD = 60
KEY_SOFT = 20
OPAQUE = 128
GREEN = (0, 255, 0, 255)
# Overlap below the neck so the chin composite doesn't leave a seam.
CHIN_OVERLAP = 14
# Walk bodies are scaled so the NECK-FROM-GROUND matches the stand's (feet
# planted, head pasted at the stand's own scale): a master take carries its
# own body proportions — the boy walk master's neck sits 7% higher from the
# ground than the committed stand's (221 vs 193 at the 400 working height,
# measured 2026-08-12) and extract/replace both inherit that frame verbatim
# (運転知見 18), so a fixed-height normalization would grow the character
# whenever he starts walking. The implied height ratio (scaled body height /
# stand height) must stay in this band: a misdetected neck (hair pinch,
# waist) implies a wildly wrong scale — fail the candidate loud and try the
# next frame instead of compositing a PR #94-class sheet.
NECK_SCALE_BAND = (0.80, 1.20)
# Head bob exaggeration gains (see compose_walk_sheet pass 2): the
# master's per-frame head deviation from the cycle mean is multiplied by
# these before the head is pasted. Calibrated 2026-08-12 on the boy walk
# master (raw bob ≈ ±0.6px at 96px cell scale; gain 4 lands the readable
# ~3px peak-to-peak the owner-era sheets showed as face motion).
# HORIZONTAL sway is structurally disabled (gain 1): the chibi head spans
# the trimmed cell's full width, so bbox-centering + the client's
# bottom-center sprite anchor cancel any head x-offset into a body/feet
# counter-shift — measured 2026-08-12, head-cx byte-identical across cells
# while feet drifted 13px. Only the VERTICAL bob survives the pipeline
# (it changes the trimmed frame height over the fixed ground line).
#
# VERTICAL gain is per-master (ledger `headBobGain`), not a global knob:
# applying 4.0 to walk-carry/boy (raw p-p already ≈ walk's amplified 3px)
# was the owner-reported "head bouncing too hard" on heavy carry
# (2026-08-12). Lowering the default would freeze the walk/boy face again.
HEAD_SWAY_GAIN = 1.0
HEAD_BOB_GAIN = 4.0
HEAD_SWAY_CAP_FRAC = 0.045


def key_pixel(r: int, g: int, b: int, a: int) -> tuple[int, int, int, int]:
    """Chroma-key green to transparent (structure anchors need real alpha)."""
    dominance = g - max(r, b)
    despilled = min(g, max(r, b))
    if dominance >= KEY_HARD:
        return (r, despilled, b, 0)
    if dominance > KEY_SOFT:
        # Soft shadow zone from wan: drop it (same as hard key for analysis).
        return (r, despilled, b, 0)
    return (r, despilled, b, a)


def chroma_key(img: Image.Image) -> Image.Image:
    out = Image.new("RGBA", img.size)
    out.putdata([key_pixel(*px) for px in img.convert("RGBA").getdata()])
    return out


# Green-wear-safe chroma key (fal replace lane, 2026-08-11). key_pixel above
# assumes the character never wears green; the otaku's plaid shirt broke that
# (its greens sit in the 20-60 dominance band the soft zone keys out, and the
# unconditional despill grays the rest). Measured separation on replace
# outputs: background green dominance ≥ 150, garment greens ≤ 60, edge mixes
# thinly in between — so definite background keys at 100+, the soft zone
# (20-100) only within the KEY_RING_PX edge ring next to definite background,
# and despill only touches that same ring. The importer's key_pixel still
# destroys green clothes at import time (asset-factory.md 運転知見 15) — this
# key is the compose-side half of that fix.
KEY_DEFINITE = 100
KEY_RING_PX = 2


def _shift(mask, dx: int, dy: int):
    """Zero-filled shift (np.roll wraps around edges — a character touching
    one border must not leak its ring onto the opposite border)."""
    import numpy as np

    out = np.zeros_like(mask)
    h, w = mask.shape
    out[max(0, dy) : h + min(0, dy), max(0, dx) : w + min(0, dx)] = mask[
        max(0, -dy) : h + min(0, -dy), max(0, -dx) : w + min(0, -dx)
    ]
    return out


def _dilate(mask, iterations: int):
    out = mask.copy()
    for _ in range(iterations):
        grown = out.copy()
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            grown |= _shift(out, dx, dy)
        out = grown
    return out


def chroma_key_greenwear(img: Image.Image) -> Image.Image:
    """Key the green screen without eating green clothes (see KEY_DEFINITE)."""
    import numpy as np

    rgba = np.asarray(img.convert("RGBA")).copy()
    r, g, b = (rgba[:, :, i].astype(int) for i in range(3))
    dominance = g - np.maximum(r, b)
    definite = dominance >= KEY_DEFINITE
    ring = _dilate(definite, KEY_RING_PX) & ~definite
    keyed = definite | (ring & (dominance > KEY_SOFT))
    rgba[:, :, 3] = np.where(keyed, 0, rgba[:, :, 3])
    despill = ring & ~keyed
    rgba[:, :, 1] = np.where(despill, np.minimum(g, np.maximum(r, b)), g).astype(
        rgba.dtype
    )
    return Image.fromarray(rgba)


def content_bbox(img: Image.Image) -> tuple[int, int, int, int]:
    """BBox of opaque pixels (green already keyed to alpha 0)."""
    bbox = img.getchannel("A").point(lambda a: 255 if a >= OPAQUE else 0).getbbox()
    if bbox is None:
        raise SystemExit("no character pixels after chroma key")
    return bbox


def trim_grounded(img: Image.Image) -> Image.Image:
    """Crop to content; feet sit on the image's bottom edge."""
    keyed = chroma_key(img)
    x0, y0, x1, y1 = content_bbox(keyed)
    return keyed.crop((x0, y0, x1, y1))


def cut_head(stand: Image.Image, neck: tuple[int, int]) -> tuple[Image.Image, int]:
    """Everything above neck_y + CHIN_OVERLAP (stand is already chroma-keyed)."""
    _, neck_y = neck
    cut_y = min(stand.height, neck_y + CHIN_OVERLAP)
    head = stand.crop((0, 0, stand.width, cut_y)).copy()
    return head, neck_y


# A component above the neck row is the OLD HEAD if it reaches up past
# this fraction of the neck height; body parts that merely poke above the
# row (a leaning stride's shoulder line rises a few px) stay well below it.
HEAD_REACH_FRAC = 0.6


def erase_old_head(body: Image.Image, neck_y: int) -> Image.Image:
    """Erase the old head above the neck row, KEEPING body pixels there.

    A full-row erase above the neck opened a 1-2px neck gap on the girl's
    walk-c (owner-reported, ①d round 2): the forward-leaning stride's
    shoulder line rises above the neck row, the erase ate it, and the head
    crop's chin overlap could not reach it. Component erase fixes it: only
    the connected component(s) that reach the head zone (HEAD_REACH_FRAC)
    are the old head; shoulder bumps stay. Measured caveat, deliberate:
    hair hanging BELOW the neck row (the girl's bob tips) is not erased —
    the replacement head's own below-neck hair pastes over it."""
    import numpy as np
    from scipy import ndimage

    rgba = np.asarray(body.convert("RGBA")).copy()
    above = rgba[:neck_y, :, 3] > 0
    labels, count = ndimage.label(above)
    if count:
        erase = np.zeros_like(above)
        for i, bounds in enumerate(ndimage.find_objects(labels)):
            if bounds is not None and bounds[0].start < neck_y * HEAD_REACH_FRAC:
                erase |= labels == i + 1
        rgba[:neck_y][erase] = 0
    return Image.fromarray(rgba)


def head_centroid(body: Image.Image, neck_y: int) -> tuple[float, float]:
    """Centroid of the pixels erase_old_head would clear — the drawn head.

    The head-sway exaggeration (compose_walk_sheet pass 2) reads its signal
    here rather than from structure_neck's valley x: the valley center
    wobbles ±2px with each pose's chin/hair asymmetry, while the drawn head
    mass moves smoothly with the master's own animation.
    """
    erased = erase_old_head(body, neck_y)
    before = body.getchannel("A")
    after = erased.getchannel("A")
    import numpy as np

    gone = (np.asarray(before) >= 128) & (np.asarray(after) < 128)
    ys, xs = np.nonzero(gone)
    if len(xs) == 0:
        return (body.width / 2, neck_y / 2)
    return (float(xs.mean()), float(ys.mean()))


def paste_head(
    body: Image.Image,
    head: Image.Image,
    stand_neck_y: int,
    body_neck: tuple[int, int],
    sway: tuple[int, int] = (0, 0),
) -> Image.Image:
    """REPLACE the body's head with the stand head at the body's neck anchor.

    Erase-then-paste: the old-head component above the body's neck row is
    cleared before the stand head lands there. Pasting alone (PR #94) leaves
    the video-drawn head visible wherever the stand head's alpha does not
    cover it — the double-head reject on avatar.boy-pants walk-a and the
    bob-hair remnants on avatar.girl-basic.

    Composites with alpha_composite, never self-masked paste:
    `paste(im, box, im)` squares the alpha of every anti-aliased pixel
    (α86→29, measured in bench_head_swap), which collapsed the girl's neck
    junction into the semi-transparent bridge art_lint's junction gate now
    rejects (①d 論点 6). The erase is by component (erase_old_head), not by
    full rows: the full-row erase ate the rising shoulder line and opened
    the walk-c neck gap.
    """
    bx, by = body_neck
    # Head image's neck is at y=stand_neck_y within the head crop. The sway
    # offset moves only the PASTE position (the exaggerated head motion);
    # the erase stays anchored on the body's true neck row.
    paste_x = bx - head.width // 2 + sway[0]
    paste_y = by - stand_neck_y + sway[1]
    out = erase_old_head(body, by) if by > 0 else body.copy()
    # Ensure canvas is large enough for a bobbing head.
    pad_top = max(0, -paste_y)
    pad_left = max(0, -paste_x)
    pad_right = max(0, paste_x + head.width - out.width)
    pad_bottom = max(0, paste_y + head.height - out.height)
    if pad_top or pad_left or pad_right or pad_bottom:
        canvas = Image.new(
            "RGBA",
            (out.width + pad_left + pad_right, out.height + pad_top + pad_bottom),
            (0, 0, 0, 0),
        )
        canvas.alpha_composite(out, (pad_left, pad_top))
        out = canvas
        paste_x += pad_left
        paste_y += pad_top
    out.alpha_composite(head, (paste_x, paste_y))
    return out


# Rows whose silhouette diverges this much from the donor cell belong to
# the striding legs; above them the carry body is static by spec. Measured
# on the pants-carry edit: head/torso rows ≤ 0.05 (outline jitter ~1px),
# torso/mitten redraw noise 0.06–0.18, legs ≥ 0.28.
CARRY_LEG_DIVERGENCE = 0.25


def staticize_carry_sheet(sheet_path: Path) -> int:
    """Unify a carry sheet's static-region shading across WALK cells.

    The carry spec holds the arms and torso still while walking — only the
    legs move — yet a whole-sheet edit redraws each cell's belly shading
    slightly differently, which flickers at play speed (owner reject
    2026-08-09). Fix: an INTERIOR COLOR TRANSPLANT — above the row where
    the legs start diverging, every walk-cell pixel that is opaque in both
    the walk cell and the (neck-aligned) donor takes the donor's RGB. Each
    cell keeps its own alpha and outline, so no silhouette seam is
    introduced (a whole-region replacement was measured to step the outline
    by up to 18% of the row width at the junction).

    The donor is WALK-A, not the stand (changed 2026-08-12, the preset-
    motion carry): the master-lane carry walk carries with both arms out
    front while the committed stand keeps the near-arm mitten idle, so the
    stand's upper body no longer matches the walk cells'. The flicker the
    transplant kills is between consecutive WALK frames at play speed; the
    stand↔walk transition is a pose change and reads as one. Returns the
    leg-seam row (donor-cell space) for logging.
    """
    sheet = Image.open(sheet_path).convert("RGBA")
    cell_w = sheet.width // 5
    cells = [
        chroma_key(sheet.crop((i * cell_w, 0, (i + 1) * cell_w, sheet.height)))
        for i in range(5)
    ]
    trimmed = [c.crop(content_bbox(c)) for c in cells]
    stand = trimmed[0]
    donor = trimmed[1]
    donor_neck = structure_neck(donor)

    # Align the other walk cells to the donor by structural neck; the carry
    # pose keeps the neck static so offsets are a couple of pixels at most.
    aligned: list[tuple[Image.Image, int, int]] = []
    for body in trimmed[2:]:
        neck = structure_neck(body)
        aligned.append((body, neck[0] - donor_neck[0], neck[1] - donor_neck[1]))

    def mask_row(img: Image.Image, y: int, dx: int) -> set[int]:
        if not 0 <= y < img.height:
            return set()
        alpha = img.getchannel("A").load()
        return {x - dx for x in range(img.width) if alpha[x, y] >= OPAQUE}

    def row_diverges(y: int) -> bool:
        donor_row = mask_row(donor, y, 0)
        for body, dx, dy in aligned:
            body_row = mask_row(body, y + dy, dx)
            union = donor_row | body_row
            if (
                len(union) >= 10
                and len(donor_row ^ body_row) / len(union) > CARRY_LEG_DIVERGENCE
            ):
                return True
        return False

    # The legs are the BOTTOM contiguous divergent run (small gaps allowed —
    # mirrored contacts can momentarily overlap). Scanning top-down for the
    # first divergent pair instead found hair-top noise rows: a nano sheet
    # edit jitters each cell's head outline by a few px, and on a 10px-wide
    # hair-tip row that already crosses the divergence line (measured on the
    # preset-motion pants-carry, 2026-08-12 — seam misdetected at row 1).
    seam = donor.height
    gap = 0
    for y in range(donor.height - 1, -1, -1):
        if row_diverges(y):
            seam = y
            gap = 0
        else:
            gap += 1
            if gap > 3:
                break
    if seam < donor.height * 0.55:
        raise SystemExit(
            f"carry staticize: silhouettes diverge from row {seam}/{donor.height} "
            "— this sheet is not upper-body-static; refusing to normalize"
        )

    donor_px = donor.load()
    # The transplant starts BELOW the head: copying the donor's face RGB
    # onto the other cells' own head outlines (which jitter by a pixel or
    # two in an edited sheet) painted a second set of eyes where the two
    # alphas disagreed — the double face the owner saw on the edited carry
    # variants (2026-08-12). The flicker this transplant kills is torso
    # shading; heads keep their own pixels.
    transplant_top = donor_neck[1] + 2
    out_cells: list[Image.Image] = [stand, donor]
    for body, dx, dy in aligned:
        merged = body.copy()
        merged_px = merged.load()
        for y in range(min(merged.height, seam + dy)):
            sy = y - dy
            if not 0 <= sy < donor.height or sy < transplant_top:
                continue
            for x in range(merged.width):
                sx = x - dx
                if not 0 <= sx < donor.width:
                    continue
                r, g, b, a = merged_px[x, y]
                sr, sg, sb, sa = donor_px[sx, sy]
                if a >= OPAQUE and sa >= OPAQUE:
                    merged_px[x, y] = (sr, sg, sb, a)
        out_cells.append(merged)

    out_w = max(cell_w, max(c.width for c in out_cells) + 8)
    out_h = max(sheet.height, max(c.height for c in out_cells) + 8)
    rebuilt = Image.new("RGBA", (out_w * 5, out_h), GREEN)
    for i, cell in enumerate(out_cells):
        rebuilt.paste(cell_on_green(cell, out_w, out_h), (i * out_w, 0))
    rebuilt.convert("RGB").save(sheet_path)
    return seam


def cell_on_green(frame: Image.Image, cell_w: int, cell_h: int) -> Image.Image:
    """Center-horizontally, feet on bottom, on a solid green cell.

    alpha_composite, not self-masked paste — same α-squared rule as
    paste_head (identical RGB on the opaque green, but the rule is uniform
    so no future caller inherits the decay by copy-paste)."""
    cell = Image.new("RGBA", (cell_w, cell_h), GREEN)
    x = (cell_w - frame.width) // 2
    y = cell_h - frame.height
    cell.alpha_composite(frame.convert("RGBA"), (x, max(0, y)))
    return cell


def compose_walk_sheet(
    stand_path: Path,
    walk_paths: dict[str, Path],
    out_path: Path,
    *,
    cell_size: int = 380,
    head_bob_gain: float = HEAD_BOB_GAIN,
) -> dict[str, tuple[int, int]]:
    """Build sheet-original.png; return per-pose structure neck anchors (pre-scale).

    `head_bob_gain` is the master's vertical exaggeration (ledger
    `headBobGain`). The module default is the walk/boy calibration; carry
    masters whose raw amplitude already matches that target pass 1.0.
    """
    stand = trim_grounded(Image.open(stand_path))
    stand_neck = structure_neck(stand)
    head, stand_neck_y = cut_head(stand, stand_neck)

    # Work at a moderate resolution: full nano/wan frames are 1000px+ and
    # make neck detection / compositing unnecessarily heavy. Import scales
    # to standHeightPx afterwards.
    target_h = 400
    if stand.height > target_h:
        scale = target_h / stand.height
        stand = stand.resize(
            (max(1, round(stand.width * scale)), target_h), Image.LANCZOS
        )
        stand_neck = structure_neck(stand)
        head, stand_neck_y = cut_head(stand, stand_neck)

    ordered = ["stand", "walk-a", "walk-b", "walk-c", "walk-d"]
    frames: list[Image.Image] = [stand]
    necks: dict[str, tuple[int, int]] = {"stand": stand_neck}
    stand_neck_from_ground = stand.height - stand_neck[1]

    # Pass 1 — pick each pose's frame and measure its neck, UNSCALED. The
    # per-frame scale is only used as an acceptance band here; the actual
    # resize happens below with ONE cycle-wide scale. A first cut normalized
    # every frame so its neck-from-ground landed EXACTLY on the stand's,
    # which erased the walk's intrinsic head bob (~±1.5% of body height in
    # the preset masters) — the owner-reported frozen face (2026-08-12).
    selected: list[tuple[str, Image.Image, tuple[int, int]]] = []
    for pose in ordered[1:]:
        candidates = walk_paths[pose]
        if isinstance(candidates, Path):
            candidates = [candidates]
        body = body_neck = None
        rejects: list[str] = []
        for candidate in candidates:
            body = trim_grounded(Image.open(candidate))
            try:
                body_neck = structure_neck(body)
            except SystemExit as exc:
                rejects.append(f"{candidate.name}: {exc}")
                body_neck = None
                continue
            scale = stand_neck_from_ground / max(1, body.height - body_neck[1])
            implied = scale * body.height / stand.height
            if not NECK_SCALE_BAND[0] <= implied <= NECK_SCALE_BAND[1]:
                # An arm swung across the chin fills the neck valley on some
                # frames; the adjacent frame usually clears it.
                rejects.append(
                    f"{candidate.name}: neck-normalized height ratio "
                    f"{implied:.2f} outside {NECK_SCALE_BAND}"
                )
                body_neck = None
                continue
            if candidate is not candidates[0]:
                print(f"{pose}: fell back to {candidate.name}")
            break
        if body is None or body_neck is None:
            raise SystemExit(
                f"{pose}: no candidate frame passed neck detection — retake "
                f"the video ({'; '.join(rejects)})"
            )
        selected.append((pose, body, body_neck))

    # Pass 2 — one scale for the whole cycle (median of the per-frame
    # ratios): the MEAN neck height matches the stand's, and each frame's
    # deviation from that mean — the bob — survives into the sheet.
    ratios = sorted(
        stand_neck_from_ground / max(1, body.height - neck[1])
        for _, body, neck in selected
    )
    cycle_scale = (ratios[1] + ratios[2]) / 2
    resized: list[tuple[str, Image.Image, tuple[int, int]]] = []
    for pose, body, _ in selected:
        body = body.resize(
            (
                max(1, round(body.width * cycle_scale)),
                max(1, round(body.height * cycle_scale)),
            ),
            Image.LANCZOS,
        )
        resized.append((pose, body, structure_neck(body)))

    # Head sway/bob exaggeration (owner reject 2026-08-12 — "the face is
    # frozen while walking"). The preset masters are mocap-realistic: their
    # own head motion measures under ±1px at 96px cell scale, while the
    # retired wan lane's exaggerated-swing recipe put the head up to 9px
    # off-center on contact frames — THAT read as a living face. Same cure,
    # different lever: amplify the master's OWN per-frame drawn-head motion
    # (head_centroid — the mass the erase clears) around the cycle mean,
    # deterministically — no re-generation, no gacha. The gain is per-master
    # (walk/boy = 4 lands ~3px p-p; walk-carry/boy = 1, its raw p-p already
    # matches that target). The neck-junction gate fails loudly if a
    # shifted head ever breaks the bridge.
    cents = [head_centroid(body, neck[1]) for _, body, neck in resized]
    nfgs = [body.height - neck[1] for _, body, neck in resized]
    mean_cx = sum(c[0] for c in cents) / len(cents)
    mean_nfg = sum(nfgs) / len(nfgs)
    for (pose, body, neck), (cx, _), nfg in zip(resized, cents, nfgs):
        cap = body.height * HEAD_SWAY_CAP_FRAC
        extra_x = max(-cap, min(cap, (HEAD_SWAY_GAIN - 1) * (cx - mean_cx)))
        extra_y = max(-cap, min(cap, (head_bob_gain - 1) * (nfg - mean_nfg)))
        composited = paste_head(
            body, head, stand_neck_y, neck, sway=(round(extra_x), round(-extra_y))
        )
        # Re-trim after paste (head may extend the bbox).
        composited = trim_grounded(composited)
        frames.append(composited)
        necks[pose] = structure_neck(composited)

    cell_w = max(cell_size, max(f.width for f in frames) + 8)
    cell_h = max(cell_size, max(f.height for f in frames) + 8)
    sheet = Image.new("RGBA", (cell_w * 5, cell_h), GREEN)
    for i, frame in enumerate(frames):
        sheet.paste(cell_on_green(frame, cell_w, cell_h), (i * cell_w, 0))
    out_path.parent.mkdir(parents=True, exist_ok=True)
    sheet.convert("RGB").save(out_path)
    return necks


def _sheet_cells(sheet_path: Path) -> list[Image.Image]:
    """Five keyed, content-trimmed cells from a green 5-cell sheet."""
    sheet = Image.open(sheet_path).convert("RGBA")
    cell_w = sheet.width // 5
    cells = []
    for i in range(5):
        cell = chroma_key(sheet.crop((i * cell_w, 0, (i + 1) * cell_w, sheet.height)))
        cells.append(cell.crop(content_bbox(cell)))
    return cells


def retarget_walk_bob(variant_sheet: Path, donor_sheet: Path, out_path: Path) -> None:
    """Re-paste the variant's stand head so each walk cell's nfg matches the donor.

    Outfit-edit variants keep their clothes; only the vertical head placement
    follows a recomposed base (the $0 path when a gain change would otherwise
    demand a paid nano re-edit). Stand is copied through unchanged.
    """
    variant = _sheet_cells(variant_sheet)
    donor = _sheet_cells(donor_sheet)
    stand = variant[0]
    stand_neck = structure_neck(stand)
    head, stand_neck_y = cut_head(stand, stand_neck)
    frames = [stand]
    for body, donor_body in zip(variant[1:], donor[1:]):
        neck = structure_neck(body)
        target = donor_body.height - structure_neck(donor_body)[1]
        current = body.height - neck[1]
        composited = trim_grounded(
            paste_head(body, head, stand_neck_y, neck, sway=(0, current - target))
        )
        try:
            new_nfg = composited.height - structure_neck(composited)[1]
        except SystemExit:
            frames.append(body)
            continue
        # A paste that fills the neck pinch (synthetic chibis, a too-large
        # sway) lands structure_neck on the waist. Keep the source cell.
        if abs(new_nfg - target) > abs(current - target):
            frames.append(body)
        else:
            frames.append(composited)
    cell_w = max(380, max(f.width for f in frames) + 8)
    cell_h = max(380, max(f.height for f in frames) + 8)
    sheet = Image.new("RGBA", (cell_w * 5, cell_h), GREEN)
    for i, frame in enumerate(frames):
        sheet.paste(cell_on_green(frame, cell_w, cell_h), (i * cell_w, 0))
    out_path.parent.mkdir(parents=True, exist_ok=True)
    sheet.convert("RGB").save(out_path)
