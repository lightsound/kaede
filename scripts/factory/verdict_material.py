"""Verdict-material rendering for the fal replace lane (機械ゲートで絞り、
最終判定はオーナー目視 — 運転知見 14).

Game-scale previews (96px cells nearest-upscaled on a light background),
the master-vs-output montage, the blink face strip, and the loop video the
owner actually judges. Pure rendering: no gates live here.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

from factory.compose_sheet import content_bbox
from factory.video import run_quiet

CELL_PAD = 8
PREVIEW_HEIGHT = 96
PREVIEW_SCALE = 3
PREVIEW_BACKGROUND = (240, 240, 245)
# The gesture runtime's DANCE_FRAME_MS precedent.
PREVIEW_FRAME_MS = 100


def scaled(cell: Image.Image, scale: float) -> Image.Image:
    if scale == 1.0:
        return cell
    return cell.resize(
        (max(1, round(cell.width * scale)), max(1, round(cell.height * scale))),
        Image.LANCZOS,
    )


def preview_cells(
    cells: list[Image.Image], height: int = PREVIEW_HEIGHT
) -> list[Image.Image]:
    """Game-scale (96px) then nearest-upscaled cells for verdict material."""
    out = []
    reference = max(c.height for c in cells)
    for cell in cells:
        small = scaled(cell, height / reference)
        out.append(
            small.resize(
                (small.width * PREVIEW_SCALE, small.height * PREVIEW_SCALE),
                Image.NEAREST,
            )
        )
    return out


def montage_rows(rows: list[list[Image.Image]], out_path: Path) -> None:
    cell_w = max(c.width for row in rows for c in row) + CELL_PAD
    cell_h = max(c.height for row in rows for c in row) + CELL_PAD
    columns = max(len(row) for row in rows)
    canvas = Image.new("RGB", (cell_w * columns, cell_h * len(rows)), PREVIEW_BACKGROUND)
    for row_i, row in enumerate(rows):
        for col_i, cell in enumerate(row):
            x = col_i * cell_w + (cell_w - cell.width) // 2
            y = row_i * cell_h + (cell_h - cell.height)
            canvas.paste(cell, (x, y), cell if cell.mode == "RGBA" else None)
    canvas.save(out_path)


def face_strip(
    frames: list[Image.Image], indices: list[int], scores: list[float], out_path: Path
) -> None:
    """Head crops of the chosen cells with eye scores — the blink visual gate."""
    tiles = []
    for index in indices:
        keyed = frames[index]
        x0, y0, x1, y1 = content_bbox(keyed)
        head = keyed.crop((x0, y0, x1, y0 + int((y1 - y0) * 0.5)))
        tiles.append((index, head.resize((160, round(head.height * 160 / head.width)))))
    tile_h = max(t.height for _, t in tiles)
    canvas = Image.new("RGB", (164 * len(tiles), tile_h + 18), (255, 255, 255))
    draw = ImageDraw.Draw(canvas)
    for i, (index, tile) in enumerate(tiles):
        canvas.paste(tile, (i * 164 + 2, 18), tile)
        draw.text((i * 164 + 2, 2), f"f{index} eye={scores[index]:.0f}", fill=(0, 0, 0))
    canvas.save(out_path)


def loop_video(cells: list[Image.Image], out_path: Path, loops: int = 3) -> None:
    scratch = out_path.parent / f"{out_path.stem}_frames"
    scratch.mkdir(parents=True, exist_ok=True)
    for old in scratch.glob("*.png"):
        old.unlink()
    previews = preview_cells(cells)
    # libx264 requires even dimensions.
    cell_w = (max(c.width for c in previews) + CELL_PAD + 1) // 2 * 2
    cell_h = (max(c.height for c in previews) + CELL_PAD + 1) // 2 * 2
    counter = 0
    for _ in range(loops):
        for cell in previews:
            canvas = Image.new("RGB", (cell_w, cell_h), PREVIEW_BACKGROUND)
            canvas.paste(cell, ((cell_w - cell.width) // 2, cell_h - cell.height), cell)
            canvas.save(scratch / f"loop_{counter:04d}.png")
            counter += 1
    run_quiet([
        "ffmpeg", "-y", "-loglevel", "error",
        "-framerate", f"{1000 / PREVIEW_FRAME_MS:g}",
        "-i", str(scratch / "loop_%04d.png"),
        "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", str(out_path),
    ])
