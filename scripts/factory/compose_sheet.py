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
# A walk frame's neck must sit where the stand's does, measured from the
# ground (feet are planted; only the head bobs). A larger gap means the
# structural detection latched onto something else (hair pinch, waist) and
# the head composite would stack a second head — fail loud and retake
# instead of committing a PR #94-class sheet.
NECK_FROM_GROUND_TOLERANCE = 0.06


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


def paste_head(
    body: Image.Image, head: Image.Image, stand_neck_y: int, body_neck: tuple[int, int]
) -> Image.Image:
    """REPLACE the body's head with the stand head at the body's neck anchor.

    Erase-then-paste: everything above the body's neck row is cleared before
    the stand head lands there. Pasting alone (PR #94) leaves the video-drawn
    head visible wherever the stand head's alpha does not cover it — the
    double-head reject on avatar.boy-pants walk-a and the bob-hair remnants
    on avatar.girl-basic.
    """
    bx, by = body_neck
    # Head image's neck is at y=stand_neck_y within the head crop.
    paste_x = bx - head.width // 2
    paste_y = by - stand_neck_y
    out = body.copy()
    if by > 0:
        out.paste((0, 0, 0, 0), (0, 0, out.width, by))
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
        canvas.paste(out, (pad_left, pad_top), out)
        out = canvas
        paste_x += pad_left
        paste_y += pad_top
    out.paste(head, (paste_x, paste_y), head)
    return out


def cell_on_green(frame: Image.Image, cell_w: int, cell_h: int) -> Image.Image:
    """Center-horizontally, feet on bottom, on a solid green cell."""
    cell = Image.new("RGBA", (cell_w, cell_h), GREEN)
    x = (cell_w - frame.width) // 2
    y = cell_h - frame.height
    cell.paste(frame, (x, max(0, y)), frame)
    return cell


def compose_walk_sheet(
    stand_path: Path,
    walk_paths: dict[str, Path],
    out_path: Path,
    *,
    cell_size: int = 380,
) -> dict[str, tuple[int, int]]:
    """Build sheet-original.png; return per-pose structure neck anchors (pre-scale)."""
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
    for pose in ordered[1:]:
        candidates = walk_paths[pose]
        if isinstance(candidates, Path):
            candidates = [candidates]
        body = body_neck = None
        rejects: list[str] = []
        for candidate in candidates:
            body = trim_grounded(Image.open(candidate))
            if body.height > target_h:
                scale = target_h / body.height
                body = body.resize(
                    (max(1, round(body.width * scale)), target_h), Image.LANCZOS
                )
            try:
                body_neck = structure_neck(body)
            except SystemExit as exc:
                rejects.append(f"{candidate.name}: {exc}")
                body_neck = None
                continue
            neck_gap = abs((body.height - body_neck[1]) - stand_neck_from_ground)
            if neck_gap > stand.height * NECK_FROM_GROUND_TOLERANCE:
                # An arm swung across the chin fills the neck valley on some
                # frames; the adjacent frame usually clears it.
                rejects.append(f"{candidate.name}: neck {neck_gap}px off ground-relative")
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
        composited = paste_head(body, head, stand_neck_y, body_neck)
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
