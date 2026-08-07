#!/usr/bin/env python3
"""Avatar parts import (Phase 5 spike): green-screen sheet -> rig-ready PNGs.

Extends the Phase 4 "最低限のアバター" pipeline (green-screen generation ->
chroma key -> downscale to 2x display resolution -> Vite src import) to a
2x2 PARTS sheet: head (top-left), torso (top-right), arm (bottom-left),
leg (bottom-right). Each part is keyed, trimmed to content, and resized to
its rig height (2x the logical height in packages/client/src/game.package/rig.ts).

Usage:
    python3 scripts/import-avatar-parts.py <sheet.png> <out-dir>
"""

import sys

from PIL import Image

# Part name -> (quadrant column, quadrant row, output height px at 2x).
# Heights are 2x the logical rig heights (see partsAvatar.ts BLUEPRINT).
PARTS = {
    "head": (0, 0, 60),
    "torso": (1, 0, 30),
    "arm": (0, 1, 20),
    "leg": (1, 1, 22),
}

# Chroma key: green dominance d = g - max(r, b). Fully transparent above
# KEY_HARD, opaque below KEY_SOFT, linear ramp between (antialiased edges).
KEY_HARD = 60
KEY_SOFT = 20


def key_pixel(r: int, g: int, b: int, a: int) -> tuple[int, int, int, int]:
    dominance = g - max(r, b)
    if dominance >= KEY_HARD:
        return (0, 0, 0, 0)
    # Despill: green never exceeds the other channels on kept pixels.
    g = min(g, max(r, b))
    if dominance > KEY_SOFT:
        a = a * (KEY_HARD - dominance) // (KEY_HARD - KEY_SOFT)
    return (r, g, b, a)


def chroma_key(img: Image.Image) -> Image.Image:
    out = Image.new("RGBA", img.size)
    out.putdata([key_pixel(*px) for px in img.convert("RGBA").getdata()])
    return out


def extract(sheet: Image.Image, col: int, row: int, target_h: int) -> Image.Image:
    w, h = sheet.size
    quad = sheet.crop((col * w // 2, row * h // 2, (col + 1) * w // 2, (row + 1) * h // 2))
    bbox = quad.getbbox()  # alpha-aware on RGBA
    if bbox is None:
        raise SystemExit(f"empty quadrant ({col},{row})")
    part = quad.crop(bbox)
    target_w = max(1, round(part.width * target_h / part.height))
    return part.resize((target_w, target_h), Image.LANCZOS)


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    sheet = chroma_key(Image.open(sys.argv[1]))
    for name, (col, row, target_h) in PARTS.items():
        part = extract(sheet, col, row, target_h)
        part.save(f"{sys.argv[2]}/{name}.png")
        print(f"{name}.png {part.width}x{part.height}")


if __name__ == "__main__":
    main()
