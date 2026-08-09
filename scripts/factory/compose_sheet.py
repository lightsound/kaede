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


def key_pixel(r: int, g: int, b: int, a: int) -> tuple[int, int, int, int]:
    dominance = g - max(r, b)
    despilled = min(g, max(r, b))
    if dominance >= KEY_HARD:
        return (0, 255, 0, 255)  # flatten to solid green (keeps sheet keyable)
    if dominance > KEY_SOFT:
        # Soft shadow zone from wan: force to solid green too.
        return (0, 255, 0, 255)
    return (r, despilled, b, a)


def flatten_green(img: Image.Image) -> Image.Image:
    out = Image.new("RGBA", img.size)
    out.putdata([key_pixel(*px) for px in img.convert("RGBA").getdata()])
    return out


def content_bbox(img: Image.Image) -> tuple[int, int, int, int]:
    """BBox of non-green, opaque-enough pixels."""
    px = img.load()
    w, h = img.size
    xs, ys = [], []
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a >= OPAQUE and (g - max(r, b)) < KEY_SOFT:
                xs.append(x)
                ys.append(y)
    if not xs:
        raise SystemExit("no character pixels after green flatten")
    return (min(xs), min(ys), max(xs) + 1, max(ys) + 1)


def trim_grounded(img: Image.Image) -> Image.Image:
    """Crop to content; feet sit on the image's bottom edge."""
    flat = flatten_green(img)
    x0, y0, x1, y1 = content_bbox(flat)
    return flat.crop((x0, y0, x1, y1))


def cut_head(stand: Image.Image, neck: tuple[int, int]) -> tuple[Image.Image, int]:
    """Everything above neck_y + CHIN_OVERLAP, with green cleared to transparent."""
    _, neck_y = neck
    cut_y = min(stand.height, neck_y + CHIN_OVERLAP)
    head = stand.crop((0, 0, stand.width, cut_y)).copy()
    px = head.load()
    for y in range(head.height):
        for x in range(head.width):
            r, g, b, a = px[x, y]
            if (g - max(r, b)) >= KEY_SOFT:
                px[x, y] = (0, 0, 0, 0)
    return head, neck_y


def paste_head(
    body: Image.Image, head: Image.Image, stand_neck_y: int, body_neck: tuple[int, int]
) -> Image.Image:
    """Place the stand head so its neck lands on the body's neck anchor."""
    bx, by = body_neck
    # Head image's neck is at y=stand_neck_y within the head crop.
    paste_x = bx - head.width // 2
    paste_y = by - stand_neck_y
    out = body.copy()
    # Ensure canvas is large enough for a bobbing head.
    pad_top = max(0, -paste_y)
    pad_left = max(0, -paste_x)
    pad_right = max(0, paste_x + head.width - out.width)
    pad_bottom = max(0, paste_y + head.height - out.height)
    if pad_top or pad_left or pad_right or pad_bottom:
        canvas = Image.new(
            "RGBA",
            (out.width + pad_left + pad_right, out.height + pad_top + pad_bottom),
            GREEN,
        )
        canvas.paste(out, (pad_left, pad_top))
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
    # Replace green in frame with transparency for clean paste, then composite.
    src = frame.copy()
    px = src.load()
    for yy in range(src.height):
        for xx in range(src.width):
            r, g, b, a = px[xx, yy]
            if (g - max(r, b)) >= KEY_SOFT:
                px[xx, yy] = (0, 0, 0, 0)
    cell.paste(src, (x, max(0, y)), src)
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

    ordered = ["stand", "walk-a", "walk-b", "walk-c", "walk-d"]
    frames: list[Image.Image] = [stand]
    necks: dict[str, tuple[int, int]] = {"stand": stand_neck}
    for pose in ordered[1:]:
        body = trim_grounded(Image.open(walk_paths[pose]))
        body_neck = structure_neck(body)
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
