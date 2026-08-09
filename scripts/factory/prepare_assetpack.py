#!/usr/bin/env python3
"""Stage game.package pose PNGs into AssetPack's `{tps}` entry folder.

Copies every avatar-body pose (and handLayer) into
`packages/client/raw-assets/avatars{tps}/<id>/` so `pnpm assets:pack` can
emit a Pixi spritesheet. Staging + atlas-out are gitignored — the committed
source of truth remains the individual PNGs.
"""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ASSET_ROOT = ROOT / "packages/client/src/game.package"
STAGE = ROOT / "packages/client/raw-assets" / "avatars{tps}"


def main() -> None:
    if STAGE.exists():
        shutil.rmtree(STAGE)
    STAGE.mkdir(parents=True)
    count = 0
    for manifest_path in sorted(ASSET_ROOT.glob("**/manifest.json")):
        manifest = json.loads(manifest_path.read_text())
        if manifest.get("type") != "avatar-body":
            continue
        dest = STAGE / manifest["id"].replace(".", "_")
        dest.mkdir(parents=True)
        base = manifest_path.parent
        for pose, meta in (manifest.get("poses") or {}).items():
            src = base / meta["file"]
            if not src.is_file():
                raise SystemExit(f"missing {src}")
            shutil.copy(src, dest / f"{pose}.png")
            count += 1
        hand = manifest.get("handLayer")
        if hand:
            src = base / hand["file"]
            if src.is_file():
                shutil.copy(src, dest / "hand.png")
                count += 1
        print(f"staged {manifest['id']} → {dest.relative_to(ROOT)}")
    print(f"{count} files staged under {STAGE.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
