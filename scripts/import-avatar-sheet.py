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
the ①b(a) layer-composition spike measured them as the near arm's fist,
tracked physically through the stride via skin-tone blob detection plus
visual confirmation; the override lives in the order so a re-run of this
script reproduces the committed manifest instead of clobbering the
measurements back to the estimate). `neckAnchors` overrides the neck
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
reproducibility.
"""

import hashlib
import json
import subprocess
import sys
from collections import Counter
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
    poses = {}
    for name, frame in zip(order["poses"], frames):
        frame.save(out_dir / f"{name}.png")
        hand = hand_overrides.get(name, list(hand_anchor(frame)))
        neck = neck_overrides.get(name, list(neck_anchor(frame)))
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
