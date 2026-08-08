#!/usr/bin/env python3
"""Held-item import (Phase 5 ①b(a) layer-composition spike): green-screen
one-shot -> trimmed transparent frame + manifest.

The held-item lane of the factory line (docs/asset-pipeline.md §4): reads an
order file (発注書), chroma-keys the generated image, trims it to content,
scales it to the ordered height (2x display resolution, the shared rule),
and writes the frame plus the manifest of docs/asset-pipeline.md §2. The
chroma-key/despeckle constants mirror import-avatar-sheet.py; 増分①b merges
the two scripts into one type-dispatched line (this spike deliberately does
not build that generalization — ROADMAP ①b 着手順⑵).

A held-item's own anchor is `grip`: the point in the item image that lands
on the body pose's `hand` anchor when composited (avatar-rig.md §2 — the
spec hole this spike found: without a grip point the renderer can only
guess the item's registration). Defaults to the image center; the order may
override with fractions of the trimmed size (e.g. a mug grips slightly
left of center because the handle side never sits in the fist).

Usage:
    python3 scripts/import-held-item.py <order.json>
"""

import hashlib
import json
import subprocess
import sys
from pathlib import Path

from PIL import Image

KEY_HARD = 60
KEY_SOFT = 20
OPAQUE = 128


def key_pixel(r: int, g: int, b: int, a: int) -> tuple[int, int, int, int]:
    dominance = g - max(r, b)
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


def palette_of(frame: Image.Image) -> list[str]:
    from collections import Counter

    counts: Counter[tuple[int, int, int]] = Counter()
    quantized = frame.convert("RGB").quantize(colors=16).convert("RGB")
    for (r, g, b), a in zip(quantized.getdata(), frame.getchannel("A").getdata()):
        if a >= OPAQUE:
            counts[(r, g, b)] += 1
    return [f"#{r:02x}{g:02x}{b:02x}" for (r, g, b), _ in counts.most_common(5)]


def sha256_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    order_path = Path(sys.argv[1])
    order = json.loads(order_path.read_text())
    base = order_path.parent
    out_dir = base / order["outDir"]

    keyed = chroma_key(Image.open(base / order["sheet"]))
    bbox = keyed.getchannel("A").point(lambda a: 255 if a >= OPAQUE else 0).getbbox()
    if bbox is None:
        raise SystemExit("empty item image after keying")
    frame = keyed.crop(bbox)

    scale = order["heightPx"] / frame.height
    frame = frame.resize(
        (max(1, round(frame.width * scale)), order["heightPx"]), Image.LANCZOS
    )

    grip_frac = order.get("grip", [0.5, 0.5])
    grip = [round(frame.width * grip_frac[0]), round(frame.height * grip_frac[1])]

    file_name = f"{order['id'].split('.')[-1]}.png"
    frame.save(out_dir / file_name)
    print(f"{file_name} {frame.width}x{frame.height} grip={grip}")

    manifest = {
        "id": order["id"],
        "type": order["type"],
        "name": order["name"],
        "author": "kaede",
        "license": "kaede-internal",
        "palette": palette_of(frame),
        "source": {
            "prompt": order["prompt"],
            "referenceHashes": [sha256_of(base / ref) for ref in order["references"]],
        },
        "frame": {
            "file": file_name,
            "size": [frame.width, frame.height],
            "anchors": {"grip": grip},
        },
    }
    manifest_path = out_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    subprocess.run(["pnpm", "exec", "biome", "format", "--write", str(manifest_path)], check=True)
    print("manifest.json")


if __name__ == "__main__":
    main()
