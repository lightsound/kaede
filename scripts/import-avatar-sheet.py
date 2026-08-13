#!/usr/bin/env python3
"""Pose-sheet import (Phase 5 増分①a): green-screen sheet -> pose frames + manifest.

The minimal factory line of docs/asset-pipeline.md §4 (増分①b grows it into
templates + art lint): reads an order file (発注書), chroma-keys the
green-screen sheet, cuts it on the frame grid (NOT the quadrant layout of the
rejected parts rig — one cell per pose), trims each frame to content so the
feet sit exactly on the frame's bottom edge (the ground baseline the renderer
anchors at the physics-AABB bottom), scales every frame by ONE factor derived
from the stand pose (so relative pose sizes survive) to 2x display
resolution, and writes the frames plus the manifest of docs/asset-pipeline.md
§2 (id/type/author/license/palette/source/poses with per-pose neck/hand
anchors — recorded from day one because retrofitting them means regenerating
the sheet; refining the VALUES later is just editing coordinates).

Anchor coordinates are pixels in the emitted frame image (origin top-left,
2x resolution). `neck` is detected as the narrowest opaque row of the frame's
chin-to-hip band (the chibi neck pinch); `hand` defaults to a proportional
estimate, overridden per pose by the order's `handAnchors` (measured values —
skin-tone blob detection plus visual confirmation; the override lives in the
order so a re-run of this script reproduces the committed manifest instead
of clobbering the measurements back to the estimate). The measured spec,
settled across the ①b(a) spike's owner/video reviews: `hand` is the CARRY
POINT — the top-center of the palm-up hand of the carry sheets' bent near
arm, where a held item's grip lands (items are bare sprites resting on
the palm, docs/asset-pipeline.md §2 held-item; the hand layer cut below
then draws the hand back OVER the item — MapleStory's layering, the
owner's z rule). Held items render ONLY on the carry pose sheets
(avatar-carry / avatar-red-carry — near arm bent at the elbow and held
still through the stride, per the owner's carry direction): on the
standard swing-walk sheets the exaggerated arm swing that makes the leg
alternation readable (①b(c)) leaves both fists prominently empty every
stride, so wherever an item is pinned, half the frames read as floating
(measured across three anchor schemes before the carry variant settled
it). Hand anchors are per-sheet measurements, never inherited: an outfit
edit redraws sleeves and moves where the hand is drawn by several pixels
(measured on the red hoodie). `neckAnchors` overrides the neck
detection the same way: the ①b(a) spike measured that the narrowest-row
heuristic breaks on outfits that widen the neck silhouette (the red
hoodie's hood makes the hip row the narrowest, landing the neck on the
hips), so an outfit-swapped sheet transfers the base sheet's measured
anchors instead (poses are identical by construction; only the frame trims
shift by a pixel).

Usage:
    python3 scripts/import-avatar-sheet.py <order.json>

The order file names the sheet, the output directory (both relative to the
order file itself), the grid, the pose per cell, and the generation prompt;
the prompt and the reference-image hashes land in manifest.source for
reproducibility. Generation originals (`*-original.png`) are not committed
(①b⑶): the order's `originals` map records their sha256, and inputs
absent from disk are fetched from the content-addressed R2 store and
verified before use (r2_originals.py — the manifest this script writes is
byte-reproducible either way).
"""

import json
import subprocess
import sys
from collections import Counter
from collections.abc import Callable
from pathlib import Path

from PIL import Image
from factory.anchors import structure_hand_carry, structure_neck
from r2_originals import (
    reference_sha256,
    resolve_asset_path,
    resolve_original,
    validate_order_path,
)

# Chroma key: green dominance d = g - max(r, b). Fully transparent above
# KEY_HARD, opaque below KEY_SOFT, linear ramp between (antialiased edges).
KEY_HARD = 60
KEY_SOFT = 20

# The chin-to-hip band (fractions of frame height) searched for the neck
# pinch, and the alpha above which a pixel counts as content.
NECK_BAND = (0.35, 0.75)
OPAQUE = 128

# Connected alpha components smaller than this fraction of the largest one
# are keying residue (stray sheet speckles), not character: drop them before
# trimming or a single pixel skews the frame's bounding box.
SPECK_FRACTION = 0.005

PALETTE_COLORS = 5


def key_pixel(r: int, g: int, b: int, a: int) -> tuple[int, int, int, int]:
    dominance = g - max(r, b)
    # Despill: green never exceeds the other channels on kept pixels — and the
    # RGB survives even at alpha 0 so downscaling never bleeds black halos.
    despilled = min(g, max(r, b))
    if dominance >= KEY_HARD:
        return (r, despilled, b, 0)
    if dominance > KEY_SOFT:
        a = a * (KEY_HARD - dominance) // (KEY_HARD - KEY_SOFT)
    return (r, despilled, b, a)


def chroma_key(img: Image.Image) -> Image.Image:
    out = Image.new("RGBA", img.size)
    out.putdata([key_pixel(*px) for px in img.convert("RGBA").getdata()])
    return out


def alpha_components(cell: Image.Image) -> list[set[tuple[int, int]]]:
    """4-connected components of the cell's nonzero-alpha pixels."""
    alpha = cell.getchannel("A").load()
    w, h = cell.size
    seen: set[tuple[int, int]] = set()
    components = []
    for start in ((x, y) for y in range(h) for x in range(w)):
        if alpha[start] == 0 or start in seen:
            continue
        component, stack = set(), [start]
        seen.add(start)
        while stack:
            x, y = stack.pop()
            component.add((x, y))
            for nb in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                if 0 <= nb[0] < w and 0 <= nb[1] < h and alpha[nb] > 0 and nb not in seen:
                    seen.add(nb)
                    stack.append(nb)
        components.append(component)
    return components


def despeckle(cell: Image.Image) -> Image.Image:
    """Clears the alpha of every speck-sized component (keying residue)."""
    components = alpha_components(cell)
    threshold = max(len(c) for c in components) * SPECK_FRACTION
    px = cell.load()
    for component in components:
        if len(component) < threshold:
            for x, y in component:
                r, g, b, _ = px[x, y]
                px[x, y] = (r, g, b, 0)
    return cell


def cut_cell(sheet: Image.Image, cols: int, rows: int, index: int) -> Image.Image:
    """One grid cell trimmed to its content: content bottom == frame bottom."""
    w, h = sheet.size
    col, row = index % cols, index // cols
    cell = sheet.crop((col * w // cols, row * h // rows, (col + 1) * w // cols, (row + 1) * h // rows))
    if cell.getchannel("A").getbbox() is None:
        raise SystemExit(f"empty sheet cell {index}")
    cell = despeckle(cell)
    bbox = cell.getchannel("A").point(lambda a: 255 if a >= OPAQUE else 0).getbbox()
    if bbox is None:
        raise SystemExit(f"empty sheet cell {index}")
    return cell.crop(bbox)


def opaque_row_span(frame: Image.Image, y: int) -> tuple[int, int] | None:
    row = [x for x in range(frame.width) if frame.getpixel((x, y))[3] >= OPAQUE]
    return (row[0], row[-1]) if row else None


def neck_anchor(frame: Image.Image) -> tuple[int, int]:
    """Structure-based neck (silhouette width valley) — see factory/anchors.py.

    Replaces the narrowest-row heuristic that the ①b(a)⑵ spike measured
    failing on hoodies (the hood widens the neck row and the hip wins).
    Color is never consulted.
    """
    return structure_neck(frame)


def hand_anchor(frame: Image.Image, *, carry: bool = False) -> tuple[int, int]:
    """Carry sheets: structure protrusion at the waist. Else: hip-height estimate."""
    if carry:
        return structure_hand_carry(frame)
    return (frame.width // 2, int(frame.height * 0.66))


def is_skin(px: tuple[int, int, int, int]) -> bool:
    r, g, b, a = px
    return a >= OPAQUE and r > 200 and 110 < g < 235 and 90 < b < 215 and r > g > b


def is_outline(px: tuple[int, int, int, int]) -> bool:
    r, g, b, a = px
    return a >= OPAQUE and r < 120 and g < 100 and b < 100


def _flood_skin(
    frame: Image.Image,
    hand: tuple[int, int],
    *,
    allow: Callable[[int, int], bool] | None = None,
) -> set[tuple[int, int]]:
    """4-connected skin pixels around the hand anchor, optionally masked."""
    w, h = frame.size
    hx, hy = hand
    seeds = [
        (x, y)
        for y in range(max(0, hy - 6), min(h, hy + 7))
        for x in range(max(0, hx - 6), min(w, hx + 7))
        if (allow is None or allow(x, y)) and is_skin(frame.getpixel((x, y)))
    ]
    if not seeds:
        raise SystemExit(f"no skin at the hand anchor ({hx},{hy}) to cut a hand layer from")
    seen, stack = set(seeds), list(seeds)
    while stack:
        x, y = stack.pop()
        for nb in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            nx, ny = nb
            if not (0 <= nx < w and 0 <= ny < h) or nb in seen:
                continue
            if allow is not None and not allow(nx, ny):
                continue
            if is_skin(frame.getpixel(nb)):
                seen.add(nb)
                stack.append(nb)
    return seen


def cut_hand_layer(
    frame: Image.Image, hand: tuple[int, int], *, near_side_only: bool = False
) -> tuple[Image.Image, list[int]]:
    """The bare hand/arm as its own layer (MapleStory's hand-over-item):
    the skin pixels 4-connected to the hand anchor, plus their dark outline
    ring, alpha-masked and cropped. Rendered ON TOP of a held item so the
    mitten reads as being in front of it (the ①b(a) spike's owner-decided
    z rule); cut from the stand frame only — the carry sheets hold the arm
    still, so one overlay serves every pose at its own hand anchor.

    `near_side_only` keeps just the NEAR-side half of the flood (pixels at
    or right of the anchor column on the right-facing sheets): the v4
    two-hand carry joins both hands into one skin blob, and drawing the
    whole blob over the item cut the plush in half with a skin band
    (owner reject 2026-08-13 — the ordering must read near arm → item →
    far arm, so only the near hand may render in front; the far hand
    stays in the body cell behind the item).

    Shirtless bodies connect the mitten to the whole torso through bare skin;
    if the unbounded fill grows past a mitten-sized bbox we retry inside a
    small ellipse so the overlay does not swallow the head.
    """
    w, h = frame.size
    hx, hy = hand
    seen = _flood_skin(frame, hand)
    if near_side_only:
        seen = {(x, y) for x, y in seen if x >= hx - 2}
    xs = [x for x, _ in seen]
    ys = [y for _, y in seen]
    too_big = (max(xs) - min(xs) > w * 0.45) or (max(ys) - min(ys) > h * 0.28)
    if too_big:
        rx, ry = max(7, w // 7), max(6, h // 14)

        def in_mitten(x: int, y: int) -> bool:
            return ((x - hx) / rx) ** 2 + ((y - hy) / ry) ** 2 <= 1.05

        seen = _flood_skin(frame, hand, allow=in_mitten)
    ring = set()
    for x, y in seen:
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                nb = (x + dx, y + dy)
                if 0 <= nb[0] < w and 0 <= nb[1] < h and nb not in seen and is_outline(frame.getpixel(nb)):
                    ring.add(nb)
    keep = seen | ring
    layer = Image.new("RGBA", frame.size, (0, 0, 0, 0))
    for x, y in keep:
        layer.putpixel((x, y), frame.getpixel((x, y)))
    bbox = layer.getchannel("A").getbbox()
    layer = layer.crop(bbox)
    return layer, [hx - bbox[0], hy - bbox[1]]


def palette_of(frames: list[Image.Image]) -> list[str]:
    """The dominant opaque colors across all frames (art-lint input, §3-3)."""
    counts: Counter[tuple[int, int, int]] = Counter()
    for frame in frames:
        quantized = frame.convert("RGB").quantize(colors=16).convert("RGB")
        for (r, g, b), a in zip(quantized.getdata(), frame.getchannel("A").getdata()):
            if a >= OPAQUE:
                counts[(r, g, b)] += 1
    return [f"#{r:02x}{g:02x}{b:02x}" for (r, g, b), _ in counts.most_common(PALETTE_COLORS)]


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    asset_root = Path(__file__).resolve().parent.parent / "packages/client/src/game.package"
    order_path = validate_order_path(Path(sys.argv[1]), asset_root)
    order = json.loads(order_path.read_text())
    base = order_path.parent
    out_dir = resolve_asset_path(base, order["outDir"], asset_root)

    # Generation originals are not committed (①b⑶ — r2_originals.py):
    # the order's `originals` map points at the R2 copy of anything absent.
    originals = order.get("originals", {})
    sheet = chroma_key(Image.open(resolve_original(base, order["sheet"], originals, asset_root)))
    grid = order["grid"]
    frames = [cut_cell(sheet, grid["cols"], grid["rows"], i) for i in range(len(order["poses"]))]

    # One scale for every frame, derived from the stand pose's target height
    # (2x display resolution): relative pose heights must survive, so walking
    # frames are NOT independently stretched to a common size.
    scale = order["standHeightPx"] / frames[order["poses"].index("stand")].height
    frames = [
        f.resize((max(1, round(f.width * scale)), max(1, round(f.height * scale))), Image.LANCZOS)
        for f in frames
    ]

    hand_overrides = order.get("handAnchors", {})
    neck_overrides = order.get("neckAnchors", {})
    carry_sheet = bool(order.get("handLayer"))
    poses = {}
    for name, frame in zip(order["poses"], frames):
        frame.save(resolve_asset_path(out_dir, f"{name}.png", asset_root))
        # Overrides must SHORT-CIRCUIT the detectors, not just win over
        # them: dict.get(k, default) evaluates the default eagerly, and the
        # structural detectors RAISE on poses they cannot read (a lying
        # sleeper, arms over the head — the ①c gesture sheet), so the old
        # one-liner failed the whole import even with every override
        # present (harmless before ①c only because the hoodie-class
        # failures returned wrong values instead of raising).
        hand = hand_overrides.get(name)
        if hand is None:
            hand = list(hand_anchor(frame, carry=carry_sheet))
        neck = neck_overrides.get(name)
        if neck is None:
            neck = list(neck_anchor(frame))
        poses[name] = {
            "file": f"{name}.png",
            "size": [frame.width, frame.height],
            "anchors": {"neck": neck, "hand": hand},
        }
        print(f"{name}.png {frame.width}x{frame.height}")

    manifest = {
        "id": order["id"],
        "type": order["type"],
        "name": order["name"],
        "author": "kaede",
        "license": "kaede-internal",
        "palette": palette_of(frames),
        "source": {
            "prompt": order["prompt"],
            "referenceHashes": [
                reference_sha256(base, ref, originals, asset_root)
                for ref in order["references"]
            ],
        },
        "poses": poses,
    }
    if order.get("handLayer"):
        # The overlay must look like the hand actually drawn on the frames
        # it rides: the light-carry walk holds a fist at the chest while
        # its (shared) stand keeps the idle waist mitten, and pasting the
        # mitten cutout over the fist read as a second floating hand
        # (差し戻し② 2026-08-13). `handLayerFrom` names the pose to cut
        # from; the default stays the stand (the heavy-carry precedent).
        layer_pose = order.get("handLayerFrom", "stand")
        layer_frame = frames[order["poses"].index(layer_pose)]
        layer_hand = poses[layer_pose]["anchors"]["hand"]
        layer, anchor = cut_hand_layer(
            layer_frame,
            (layer_hand[0], layer_hand[1]),
            near_side_only=order.get("handLayerSide") == "near",
        )
        layer.save(resolve_asset_path(out_dir, "hand.png", asset_root))
        manifest["handLayer"] = {
            "file": "hand.png",
            "size": [layer.width, layer.height],
            "anchors": {"grip": anchor},
        }
        print(f"hand.png {layer.width}x{layer.height} grip={anchor}")
    manifest_path = out_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    # The manifest is committed data reviewed in PRs: keep it in the repo's
    # one JSON style so a re-run never trips `pnpm lint`.
    subprocess.run(["pnpm", "exec", "biome", "format", "--write", str(manifest_path)], check=True)
    print("manifest.json")


if __name__ == "__main__":
    main()
