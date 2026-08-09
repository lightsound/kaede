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
guess the item's registration). Items are BARE sprites that REST ON the
body sheet's drawn hand, MapleStory-style (owner direction 2026-08-09 —
baked-in gripping hands were rejected: too realistic for the chibi style
and not generic across items): grip = the resting contact point, given as
fractions of the trimmed size. The convention, verified across five item
classes (mug / notebook / umbrella / plush / spear): resting items use
[0.5, 0.95] (bottom-center, slight overlap so the mitten peeks beneath);
long shafted items use the measured shaft point where the hand carries
them (umbrella mid-shaft [0.5, 0.5], spear lower-third [0.315, 0.7]).

Generation originals (`*-original.png`) are not committed (①b⑶): the
order's `originals` map records their sha256, and inputs absent from disk
are fetched from the content-addressed R2 store and verified before use
(r2_originals.py).

Usage:
    python3 scripts/import-held-item.py <order.json>
"""

import json
import subprocess
import sys
from pathlib import Path

from PIL import Image
from r2_originals import (
    reference_sha256,
    resolve_asset_path,
    resolve_original,
    validate_order_path,
)

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
    keyed = chroma_key(Image.open(resolve_original(base, order["sheet"], originals, asset_root)))
    bbox = keyed.getchannel("A").point(lambda a: 255 if a >= OPAQUE else 0).getbbox()
    if bbox is None:
        raise SystemExit("empty item image after keying")
    frame = keyed.crop(bbox)
    # Held items are authored facing right with the grip hand on the LEFT
    # (item body extends forward); `flip` mirrors a generation that came out
    # the other way around instead of paying for a re-roll.
    if order.get("flip"):
        frame = frame.transpose(Image.FLIP_LEFT_RIGHT)

    scale = order["heightPx"] / frame.height
    frame = frame.resize(
        (max(1, round(frame.width * scale)), order["heightPx"]), Image.LANCZOS
    )

    grip_frac = order.get("grip", [0.5, 0.5])
    grip = [round(frame.width * grip_frac[0]), round(frame.height * grip_frac[1])]

    file_name = f"{order['id'].split('.')[-1]}.png"
    frame.save(resolve_asset_path(out_dir, file_name, asset_root))
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
            "referenceHashes": [
                reference_sha256(base, ref, originals, asset_root)
                for ref in order["references"]
            ],
        },
        "frame": {
            "file": file_name,
            "size": [frame.width, frame.height],
            "anchors": {"grip": grip},
        },
    }
    manifest_path = resolve_asset_path(out_dir, "manifest.json", asset_root)
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    subprocess.run(["pnpm", "exec", "biome", "format", "--write", str(manifest_path)], check=True)
    print("manifest.json")


if __name__ == "__main__":
    main()
