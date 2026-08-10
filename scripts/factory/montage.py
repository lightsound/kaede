"""Review montage for the visual gate (factory stage ⑥ → PR).

Renders a manifest's pose frames (optionally several manifests as rows)
upscaled on a light background, feet ground-aligned — the image the operator
and the owner actually judge. Machine lint narrows; eyes decide.
"""

from __future__ import annotations

import json
from pathlib import Path

from PIL import Image

BACKGROUND = (240, 240, 245)
CELL_PADDING = 10
SCALE = 3


def _frames_of(manifest_path: Path) -> list[Image.Image]:
    manifest = json.loads(manifest_path.read_text())
    base = manifest_path.parent
    return [
        Image.open(base / meta["file"]).convert("RGBA")
        for meta in manifest.get("poses", {}).values()
    ]


def sheet_montage(
    manifest_paths: Path | list[Path], out_path: Path, *, scale: int = SCALE
) -> Path:
    """One row per manifest, one cell per pose, upscaled NEAREST (pixel look)."""
    paths = [manifest_paths] if isinstance(manifest_paths, Path) else list(manifest_paths)
    rows = [_frames_of(p) for p in paths]
    if not rows or not any(rows):
        raise SystemExit("no pose frames to montage")
    cell_w = max(f.width for row in rows for f in row) + CELL_PADDING
    cell_h = max(f.height for row in rows for f in row) + CELL_PADDING
    columns = max(len(row) for row in rows)
    canvas = Image.new(
        "RGB", (cell_w * columns * scale, cell_h * len(rows) * scale), BACKGROUND
    )
    for row_i, row in enumerate(rows):
        for col_i, frame in enumerate(row):
            big = frame.resize((frame.width * scale, frame.height * scale), Image.NEAREST)
            x = col_i * cell_w * scale + (cell_w * scale - big.width) // 2
            y = row_i * cell_h * scale + (cell_h * scale - big.height)
            canvas.paste(big, (x, y), big)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out_path)
    return out_path
