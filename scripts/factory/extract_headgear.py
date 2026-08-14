#!/usr/bin/env python3
"""Headgear extraction — the ①c status-visualization lane (取り込み中=ヘッドホン).

Cuts the worn headgear out of a keep-everything nano-banana-2 edit (the
character WEARING it, everything else pixel-identical — the ①c bench take)
by differencing against the base stand frame, and prepares a standard
held-item order for import-held-item.py: the emitted `item-original.png`
is the bare headgear on green, `grip` is the point that lands on a pose's
NECK anchor (headgear rides the neck the way held items ride the hand —
the handLayer precedent, aimed one anchor higher), and `heightPx` matches
the avatar frames' 4x scale.

Why diff, not generation: a bare "headphones only" generation has no
registration against the head (the spec hole the held-item spike hit,
solved there by grips measured per class); wearing edits are one take and
carry their own registration — the diff pixels sit exactly where the gear
sits on the head, so grip-on-neck reproduces the worn look on every pose
whose neck anchor is measured (the gesture sheet's hair-blob anchors).
The overlay hides on the sleep pose (a lying head would need a rotated
overlay — out of scope, the sleep pose already communicates absence).

Usage:
    python3 scripts/factory/extract_headgear.py \
        packages/client/src/game.package/items/headphones/order.json
    python3 scripts/upload-asset-originals.py <same order.json>
    python3 scripts/import-held-item.py <same order.json>
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

from factory.anchors import structure_neck  # noqa: E402
from factory.compose_sheet import chroma_key, content_bbox  # noqa: E402
from r2_originals import resolve_asset_path, resolve_original, validate_order_path  # noqa: E402

ASSET_ROOT = ROOT / "packages/client/src/game.package"

# The bench canvas geometry (compose_gesture_sheet.py shares these).
CANVAS = 720
CANVAS_CHAR_H = 470
NANO_SIZE = 1024
CANVAS_GROUND_Y = 640

# Diff pixels closer than this (RGB distance) to the base are the base
# showing through, not gear; components smaller than this fraction of the
# largest are edit noise (anti-aliased hair edges — measured).
DIFF_MIN = 60
COMPONENT_MIN_FRACTION = 0.02


def canvas_of_stand(stand_src: Image.Image) -> tuple[Image.Image, tuple[int, int]]:
    """The stand placed exactly as prepare_stand_canvas placed it for the
    bench generations, plus its top-left offset on the canvas."""
    scale = CANVAS_CHAR_H / stand_src.height
    resized = stand_src.resize(
        (max(1, round(stand_src.width * scale)), CANVAS_CHAR_H), Image.LANCZOS
    )
    x = (CANVAS - resized.width) // 2
    y = CANVAS_GROUND_Y - resized.height
    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 255, 0, 255))
    canvas.paste(resized, (x, y), resized)
    return canvas, (x, y)


def largest_components(mask: np.ndarray) -> np.ndarray:
    """Keeps every 4-connected component within COMPONENT_MIN_FRACTION of
    the largest (the ear cups and the band may be disjoint)."""
    from scipy import ndimage

    labels, count = ndimage.label(mask)
    if count == 0:
        raise SystemExit("no gear pixels found in the diff")
    sizes = ndimage.sum(mask, labels, range(1, count + 1))
    keep = {i + 1 for i, s in enumerate(sizes) if s >= sizes.max() * COMPONENT_MIN_FRACTION}
    return np.isin(labels, list(keep))


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    order_path = validate_order_path(Path(sys.argv[1]), ASSET_ROOT)
    order = json.loads(order_path.read_text())
    base = order_path.parent

    stand_src = Image.open(
        resolve_asset_path(base, order["standSource"], ASSET_ROOT)
    ).convert("RGBA")
    base_canvas, (off_x, off_y) = canvas_of_stand(stand_src)

    worn = Image.open(
        resolve_original(base, "worn-original.png", order["gestureSources"], ASSET_ROOT)
    ).convert("RGBA")
    worn = worn.resize((CANVAS, CANVAS), Image.LANCZOS)

    a = np.asarray(base_canvas.convert("RGB")).astype(int)
    b = np.asarray(worn.convert("RGB")).astype(int)
    diff = np.sqrt(((a - b) ** 2).sum(axis=2)) > DIFF_MIN
    # Gear must be worn on the HEAD: restrict to rows above the stand's
    # structural neck (canvas coordinates), padded for a band over the hair.
    stand_cell = chroma_key(stand_src)
    stand_cell = stand_cell.crop(content_bbox(stand_cell))
    neck = structure_neck(stand_cell)
    neck_canvas_y = off_y + round(neck[1] * (CANVAS_CHAR_H / stand_cell.height))
    neck_canvas_x = off_x + round(neck[0] * (CANVAS_CHAR_H / stand_cell.height))
    diff[neck_canvas_y + 10 :, :] = False
    gear = largest_components(diff)

    out = np.zeros((CANVAS, CANVAS, 4), np.uint8)
    worn_px = np.asarray(worn)
    out[gear] = worn_px[gear]
    ys, xs = np.where(gear)
    x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
    cut = Image.fromarray(out[y0:y1, x0:x1], "RGBA")

    # Green-screen input for the standard held-item importer, plus the
    # measured registration: grip = the stand's neck anchor in cut-image
    # fractions, heightPx = the cut's height at the avatar frames' scale.
    sheet = Image.new("RGBA", cut.size, (0, 255, 0, 255))
    sheet.paste(cut, (0, 0), cut)
    sheet_path = resolve_asset_path(base, order["sheet"], ASSET_ROOT)
    sheet.convert("RGB").save(sheet_path)

    import_scale = order["standHeightPx"] / CANVAS_CHAR_H
    order["grip"] = [
        round((neck_canvas_x - int(x0)) / cut.width, 4),
        round((neck_canvas_y - int(y0)) / cut.height, 4),
    ]
    order["heightPx"] = max(1, round(cut.height * import_scale))
    order_path.write_text(json.dumps(order, ensure_ascii=False, indent=2) + "\n")
    subprocess.run(["pnpm", "exec", "biome", "format", "--write", str(order_path)], check=True)
    print(
        f"wrote {sheet_path} ({cut.width}x{cut.height}); grip={order['grip']} "
        f"heightPx={order['heightPx']}"
    )


if __name__ == "__main__":
    main()
