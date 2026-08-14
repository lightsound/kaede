#!/usr/bin/env python3
"""Derive a one-hand light-carry sheet from its two-hand heavy sibling by
erasing the OUTER hand from each walk cell (差し戻し④ 2026-08-13).

The v4 heavy master (Texting_Walk) holds both hands at the belly: the NEAR
hand crosses in front of the torso, the FAR arm reaches around from behind
so only its hand shows, sticking out past the torso silhouette. The owner
wants light items carried ONE-handed; casting a still one-hand walk kept
failing (seedance re-poses the arm — three rejected takes; nano re-poses
inconsistently per cell — measured walk-b/d dropping both arms). Erasing
the far hand is deterministic and matches the approved v1 carry design:
"his far arm hangs straight down BEHIND his torso" — an invisible far arm.

The erase floods the skin blob from a per-cell seed (the outer hand),
clears every flooded pixel at or right of the cut column plus its outline
ring, then re-outlines the newly exposed skin edge with the darkest
neighboring outline color so the near hand keeps a drawn border.

Usage:
    python3 scripts/factory/derive_light_carry.py <light-order.json> \
        --cut-x N --seeds walk-a=X,Y walk-b=X,Y walk-c=X,Y walk-d=X,Y

Writes the light order's sheet-original.png from the heavy sheet named by
the order's editSource; the standard import + lint stay the gates.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

from r2_originals import resolve_asset_path, resolve_original, validate_order_path  # noqa: E402

ASSET_ROOT = ROOT / "packages/client/src/game.package"
OPAQUE = 128
POSES = ["stand", "walk-a", "walk-b", "walk-c", "walk-d"]


def is_skin(px: tuple[int, int, int, int]) -> bool:
    r, g, b, a = px
    return a >= OPAQUE and r > 200 and 110 < g < 235 and 90 < b < 215 and r > g > b


def is_outline(px: tuple[int, int, int, int]) -> bool:
    r, g, b, a = px
    return a >= OPAQUE and r < 140 and g < 120 and b < 120


def erase_outer_hand(cell: Image.Image, seed: tuple[int, int], cut_x: int) -> int:
    """Clear the outer-hand skin blob (and its outline ring) at/right of
    `cut_x`; re-outline the exposed edge. Returns erased pixel count."""
    px = cell.load()
    w, h = cell.size
    sx, sy = seed
    seeds = [
        (x, y)
        for y in range(max(0, sy - 5), min(h, sy + 6))
        for x in range(max(0, sx - 5), min(w, sx + 6))
        if is_skin(px[x, y])
    ]
    if not seeds:
        raise SystemExit(f"no skin at outer-hand seed {seed}")
    seen, stack = set(seeds), list(seeds)
    while stack:
        x, y = stack.pop()
        for nb in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if 0 <= nb[0] < w and 0 <= nb[1] < h and nb not in seen and is_skin(px[nb]):
                seen.add(nb)
                stack.append(nb)
    # Shirtless bodies connect the hand to the whole body through skin;
    # the row band keeps the erase to the hand's height (head/legs safe).
    blob = {(x, y) for x, y in seen if x >= cut_x and abs(y - sy) <= 7}
    ring = set()
    for x, y in blob:
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                nb = (x + dx, y + dy)
                if (
                    0 <= nb[0] < w
                    and 0 <= nb[1] < h
                    and nb not in blob
                    and is_outline(px[nb])
                    and nb[0] >= cut_x
                ):
                    ring.add(nb)
    erase = blob | ring
    for x, y in erase:
        px[x, y] = (0, 0, 0, 0)
    # Re-outline the cut edge: opaque pixels now bordering transparency at
    # the cut column get the sheet's outline tone so the near hand keeps a
    # drawn border instead of a raw skin edge.
    edge = []
    for x, y in erase:
        for nb in ((x - 1, y), (x, y - 1), (x, y + 1)):
            if 0 <= nb[0] < w and 0 <= nb[1] < h and px[nb][3] >= OPAQUE and not is_outline(px[nb]):
                edge.append(nb)
    for x, y in set(edge):
        r, g, b, a = px[x, y]
        px[x, y] = (max(0, r - 130), max(0, g - 140), max(0, b - 140), a)
    return len(erase)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("order", type=Path)
    parser.add_argument("--cut-x", type=int, required=True, help="erase at/right of this column (cell coords)")
    parser.add_argument("--seeds", nargs=4, required=True, help="walk-a=X,Y ... outer-hand seed per walk cell")
    args = parser.parse_args()

    order_path = validate_order_path(args.order, ASSET_ROOT)
    order = json.loads(order_path.read_text())
    base = order_path.parent
    source = resolve_original(base, order["editSource"], order.get("originals", {}), ASSET_ROOT)
    sheet = Image.open(source).convert("RGBA")
    cell_w = sheet.width // 5

    seeds = {}
    for spec in args.seeds:
        pose, _, xy = spec.partition("=")
        x, _, y = xy.partition(",")
        seeds[pose] = (int(x), int(y))

    # The sheet works in composed-cell coordinates: each cell is trimmed at
    # import, so the per-cell seed refers to the IMPORTED frame; map it back
    # through the cell's content bbox at the compose scale.
    from factory.compose_sheet import chroma_key, content_bbox

    out = sheet.copy()
    for i, pose in enumerate(POSES):
        if pose not in seeds:
            continue
        box = (i * cell_w, 0, (i + 1) * cell_w, sheet.height)
        cell = chroma_key(sheet.crop(box))
        x0, y0, x1, y1 = content_bbox(cell)
        # imported frame scale: standHeightPx over the stand cell's content height
        stand_cell = chroma_key(sheet.crop((0, 0, cell_w, sheet.height)))
        sx0, sy0, sx1, sy1 = content_bbox(stand_cell)
        scale = (sy1 - sy0) / order["standHeightPx"]
        seed = seeds[pose]
        cell_seed = (round(seed[0] * scale) + x0, round(seed[1] * scale) + y0)
        cut = round(args.cut_x * scale) + x0
        erased = erase_outer_hand(cell, cell_seed, cut)
        print(f"{pose}: erased {erased}px (seed {cell_seed}, cut x≥{cut})")
        # write back on green
        green = Image.new("RGBA", cell.size, (0, 255, 0, 255))
        green.alpha_composite(cell)
        out.paste(green.convert("RGB").convert("RGBA"), box)

    dest = resolve_asset_path(base, order["sheet"], ASSET_ROOT)
    out.convert("RGB").save(dest)
    print(f"wrote {dest}")


if __name__ == "__main__":
    main()
