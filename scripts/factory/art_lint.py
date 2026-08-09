"""Art lint for imported avatar sheets (asset-pipeline.md §3-3).

Checks run after import (or dry against an existing outDir). Failures exit
non-zero so the factory line refuses to commit a out-of-spec sheet.

Anchor divergence uses structure-based detection (anchors.py) — never skin
color — closing the three ①b(a)⑵ holes (hoodie neck, beige contamination,
and the need for order overrides to be validated rather than trusted blind).

Palette contrast compares the sheet's dominant colors to a base outfit's
committed palette (default avatar.boy-basic) so white-on-white items/clothes
fail loud at import time instead of at game-scale review.
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

from PIL import Image

# scripts/ on sys.path when run as a module from repo root.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from factory.anchors import structure_neck  # noqa: E402

OPAQUE = 128
# 2x-resolution pixels. A 4px miss at source = 2 logical px on screen.
NECK_DIVERGENCE_PX = 10
# Euclidean RGB distance; white (#ffffff) vs near-white shirt fails below ~40.
MIN_PALETTE_DISTANCE = 35
STAND_HEIGHT_RANGE = (88, 104)  # standHeightPx target 96 ± slack
# Carry mitten rests in front of the waist (not out at the silhouette edge —
# the arm is bent across the torso). Structural presence = opaque pixel in
# the waist band; skin-tone is never consulted (beige-clothes hole).
HAND_WAIST_BAND = (0.50, 0.85)


def _dist(a: tuple[int, int, int], b: tuple[int, int, int]) -> float:
    return math.sqrt(sum((x - y) ** 2 for x, y in zip(a, b)))


def _parse_hex(color: str) -> tuple[int, int, int]:
    c = color.lstrip("#")
    return (int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16))


def chroma_residue_ratio(frame: Image.Image) -> float:
    """Fraction of opaque-ish pixels that are still green-dominant."""
    total = kept = 0
    for r, g, b, a in frame.convert("RGBA").getdata():
        if a < 16:
            continue
        total += 1
        if g - max(r, b) >= 40:
            kept += 1
    return kept / total if total else 0.0


def lint_avatar(
    manifest_path: Path,
    *,
    base_palette: list[str] | None = None,
    expect_carry_hand: bool = False,
) -> list[str]:
    """Return a list of human-readable failures (empty = pass)."""
    manifest = json.loads(manifest_path.read_text())
    base = manifest_path.parent
    failures: list[str] = []
    poses = manifest.get("poses") or {}
    if "stand" not in poses:
        failures.append("missing stand pose")
        return failures

    stand = poses["stand"]
    stand_h = stand["size"][1]
    if not STAND_HEIGHT_RANGE[0] <= stand_h <= STAND_HEIGHT_RANGE[1]:
        failures.append(
            f"stand height {stand_h}px outside {STAND_HEIGHT_RANGE} "
            f"(target standHeightPx≈96)"
        )

    for name, pose in poses.items():
        frame_path = base / pose["file"]
        if not frame_path.is_file():
            failures.append(f"{name}: missing file {pose['file']}")
            continue
        frame = Image.open(frame_path).convert("RGBA")
        residue = chroma_residue_ratio(frame)
        if residue > 0.01:
            failures.append(f"{name}: chroma residue {residue:.2%} > 1%")

        recorded_neck = pose.get("anchors", {}).get("neck")
        try:
            detected_neck = list(structure_neck(frame))
        except SystemExit as exc:
            failures.append(f"{name}: structure neck failed — {exc}")
            detected_neck = None
        if recorded_neck and detected_neck:
            d = math.dist(recorded_neck, detected_neck)
            if d > NECK_DIVERGENCE_PX:
                failures.append(
                    f"{name}: neck divergence {d:.1f}px "
                    f"(recorded {recorded_neck}, structure {detected_neck}) "
                    f"> {NECK_DIVERGENCE_PX}"
                )

        if expect_carry_hand or (name == "stand" and manifest.get("handLayer")):
            recorded_hand = pose.get("anchors", {}).get("hand")
            if recorded_hand:
                hx, hy = recorded_hand
                lo = int(frame.height * HAND_WAIST_BAND[0])
                hi = int(frame.height * HAND_WAIST_BAND[1])
                if not (0 <= hx < frame.width and 0 <= hy < frame.height):
                    failures.append(f"{name}: hand anchor out of frame {recorded_hand}")
                elif not (lo <= hy < hi):
                    failures.append(
                        f"{name}: hand y={hy} outside waist band [{lo},{hi}) "
                        f"— carry mitten must sit at the waist (not chest/hips)"
                    )
                elif frame.getpixel((hx, hy))[3] < OPAQUE:
                    failures.append(
                        f"{name}: hand anchor {recorded_hand} is transparent "
                        f"(not on the mitten — structural presence check)"
                    )

    if base_palette:
        sheet_palette = [_parse_hex(c) for c in manifest.get("palette", [])]
        base_colors = [_parse_hex(c) for c in base_palette]
        if sheet_palette and base_colors:
            # Best (minimum) distance from each sheet color to the base set;
            # the sheet must have at least one color that clearly contrasts.
            best = max(
                min(_dist(sc, bc) for bc in base_colors) for sc in sheet_palette
            )
            if best < MIN_PALETTE_DISTANCE:
                failures.append(
                    f"palette contrast {best:.1f} < {MIN_PALETTE_DISTANCE} "
                    f"vs base outfit (sheet may disappear on the default clothes)"
                )

    return failures


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("usage: art_lint.py <manifest.json> [--base-palette-manifest PATH]")
    manifest_path = Path(sys.argv[1])
    base_palette = None
    if "--base-palette-manifest" in sys.argv:
        bp = Path(sys.argv[sys.argv.index("--base-palette-manifest") + 1])
        base_palette = json.loads(bp.read_text()).get("palette")
    expect_carry = "--carry" in sys.argv
    failures = lint_avatar(
        manifest_path, base_palette=base_palette, expect_carry_hand=expect_carry
    )
    if failures:
        print("ART LINT FAIL", file=sys.stderr)
        for f in failures:
            print(f"  - {f}", file=sys.stderr)
        raise SystemExit(1)
    print("ART LINT PASS")


if __name__ == "__main__":
    main()
