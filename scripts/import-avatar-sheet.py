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
chin-to-hip band (the chibi neck pinch); `hand` is a proportional estimate
(unused until 増分①d, which refines it without touching the sheet).

The line also applies the far-leg shading convention (the order's
`legShading`): the leg farther from the viewer is darkened and the near leg
lightened, MapleStory-style. Flat-shaded chibi limbs are identical in color,
so "left leg forward" and "right leg forward" are otherwise the same picture
— without this pass a walk cycle reads as skipping on one leg (the 増分①a
owner review). Generation cannot be trusted with it (text prompts collapse
both contact poses onto one stride), so the line enforces it mechanically:
legs are segmented by growing outward from the two shoe blobs, and the
order names which leg is FAR per pose (left / right / raised / planted).

Usage:
    python3 scripts/import-avatar-sheet.py <order.json>

The order file names the sheet, the output directory (both relative to the
order file itself), the grid, the pose per cell, and the generation prompt;
the prompt and the reference-image hashes land in manifest.source for
reproducibility.
"""

import hashlib
import json
import subprocess
import sys
from collections import Counter, deque
from pathlib import Path

from PIL import Image

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

# Far-leg shading: the fraction of the frame height where the leg region
# starts (below the belt), and the pixel filters that bound it. Bright
# pixels (skin, the white shirt) are never leg; the shoe browns seed the
# per-leg segmentation (hair is also brown but lives above the band).
LEG_BAND = 0.60


def is_bright(r: int, g: int, b: int) -> bool:
    return (r > 200 and g > 160) or (r > 190 and g > 190 and b > 190)


def is_shoe(r: int, g: int, b: int) -> bool:
    return 40 <= r <= 190 and g <= r * 0.65 + 15 and b <= g + 10

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


def connected(pixels: set[tuple[int, int]]) -> list[set[tuple[int, int]]]:
    """4-connected components of a pixel set."""
    seen: set[tuple[int, int]] = set()
    components = []
    for start in pixels:
        if start in seen:
            continue
        component, stack = set(), [start]
        seen.add(start)
        while stack:
            x, y = stack.pop()
            component.add((x, y))
            for nb in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                if nb in pixels and nb not in seen:
                    seen.add(nb)
                    stack.append(nb)
        components.append(component)
    return components


def alpha_components(cell: Image.Image) -> list[set[tuple[int, int]]]:
    """4-connected components of the cell's nonzero-alpha pixels."""
    alpha = cell.getchannel("A").load()
    w, h = cell.size
    return connected({(x, y) for x in range(w) for y in range(h) if alpha[x, y] > 0})


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


# How the order names the FAR leg per pose, resolved against the two shoe
# blobs' centroids: image-left / image-right / the lifted knee / the foot on
# the ground. The dark leg then travels like a real leg through the cycle
# (back -> swinging forward -> front -> supporting).
FAR_LEG_PICKS = {
    "left": lambda c: min((0, 1), key=lambda i: c[i][0]),
    "right": lambda c: max((0, 1), key=lambda i: c[i][0]),
    "raised": lambda c: min((0, 1), key=lambda i: c[i][1]),
    "planted": lambda c: max((0, 1), key=lambda i: c[i][1]),
}


def assign_legs(frame: Image.Image) -> dict[tuple[int, int], int] | None:
    """Maps each leg-band pixel to leg 0/1 by growing outward from the two
    shoe blobs (multi-source BFS): the belt stays untouched above the band,
    and the split lands along the inseam where a shading boundary belongs."""
    px = frame.load()
    band = {
        (x, y)
        for x in range(frame.width)
        for y in range(int(frame.height * LEG_BAND), frame.height)
        if px[x, y][3] > 0 and not is_bright(*px[x, y][:3])
    }
    shoes = sorted(connected({p for p in band if is_shoe(*px[p][:3])}), key=len, reverse=True)[:2]
    if len(shoes) < 2:
        return None
    owner: dict[tuple[int, int], int] = {}
    queue: deque[tuple[int, int]] = deque()
    for leg, shoe in enumerate(shoes):
        for p in shoe:
            owner[p] = leg
            queue.append(p)
    while queue:
        x, y = queue.popleft()
        for nb in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if nb in band and nb not in owner:
                owner[nb] = owner[(x, y)]
                queue.append(nb)
    return owner


def shade_legs(frame: Image.Image, pose: str, shading: dict) -> None:
    """Darkens the FAR leg and lightens the near one (module docstring)."""
    owner = assign_legs(frame)
    if owner is None:
        raise SystemExit(f"{pose}: cannot segment two legs for far-leg shading")
    centroids = [[0.0, 0.0], [0.0, 0.0]]
    counts = [0, 0]
    for (x, y), leg in owner.items():
        centroids[leg][0] += x
        centroids[leg][1] += y
        counts[leg] += 1
    for leg in (0, 1):
        centroids[leg] = [v / counts[leg] for v in centroids[leg]]
    far = FAR_LEG_PICKS[shading["farLegByPose"][pose]](centroids)
    px = frame.load()
    for p, leg in owner.items():
        r, g, b, a = px[p]
        factor = shading["far"] if leg == far else shading["near"]
        px[p] = (min(255, int(r * factor)), min(255, int(g * factor)), min(255, int(b * factor)), a)


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
    """The narrowest opaque row of the chin-to-hip band: the chibi neck pinch."""
    lo, hi = (int(frame.height * f) for f in NECK_BAND)
    best: tuple[int, tuple[int, int]] | None = None
    for y in range(lo, hi):
        span = opaque_row_span(frame, y)
        if span and (best is None or span[1] - span[0] < best[1][1] - best[1][0]):
            best = (y, span)
    if best is None:
        raise SystemExit("no opaque rows in the neck band")
    y, (x0, x1) = best
    return ((x0 + x1) // 2, y)


def hand_anchor(frame: Image.Image) -> tuple[int, int]:
    """Proportional estimate (hands ride at hip height on a chibi); 増分①d refines."""
    return (frame.width // 2, int(frame.height * 0.66))


def palette_of(frames: list[Image.Image]) -> list[str]:
    """The dominant opaque colors across all frames (art-lint input, §3-3)."""
    counts: Counter[tuple[int, int, int]] = Counter()
    for frame in frames:
        quantized = frame.convert("RGB").quantize(colors=16).convert("RGB")
        for (r, g, b), a in zip(quantized.getdata(), frame.getchannel("A").getdata()):
            if a >= OPAQUE:
                counts[(r, g, b)] += 1
    return [f"#{r:02x}{g:02x}{b:02x}" for (r, g, b), _ in counts.most_common(PALETTE_COLORS)]


def sha256_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    order_path = Path(sys.argv[1])
    order = json.loads(order_path.read_text())
    base = order_path.parent
    out_dir = base / order["outDir"]

    sheet = chroma_key(Image.open(base / order["sheet"]))
    grid = order["grid"]
    frames = [cut_cell(sheet, grid["cols"], grid["rows"], i) for i in range(len(order["poses"]))]
    for name, frame in zip(order["poses"], frames):
        shade_legs(frame, name, order["legShading"])

    # One scale for every frame, derived from the stand pose's target height
    # (2x display resolution): relative pose heights must survive, so walking
    # frames are NOT independently stretched to a common size.
    scale = order["standHeightPx"] / frames[order["poses"].index("stand")].height
    frames = [
        f.resize((max(1, round(f.width * scale)), max(1, round(f.height * scale))), Image.LANCZOS)
        for f in frames
    ]

    poses = {}
    for name, frame in zip(order["poses"], frames):
        frame.save(out_dir / f"{name}.png")
        poses[name] = {
            "file": f"{name}.png",
            "size": [frame.width, frame.height],
            "anchors": {"neck": list(neck_anchor(frame)), "hand": list(hand_anchor(frame))},
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
            "referenceHashes": [sha256_of(base / ref) for ref in order["references"]],
        },
        "poses": poses,
    }
    manifest_path = out_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    # The manifest is committed data reviewed in PRs: keep it in the repo's
    # one JSON style so a re-run never trips `pnpm lint`.
    subprocess.run(["pnpm", "exec", "biome", "format", "--write", str(manifest_path)], check=True)
    print("manifest.json")


if __name__ == "__main__":
    main()
