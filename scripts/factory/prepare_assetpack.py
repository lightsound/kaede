#!/usr/bin/env python3
"""Stage game.package pose PNGs into AssetPack's `{tps}` entry folder.

Copies every avatar-body pose (and handLayer) into
`packages/client/raw-assets/avatars{tps}/<id>/` so `pnpm assets:pack` can
emit a Pixi spritesheet. Staging + atlas-out are gitignored — the committed
source of truth remains the individual PNGs.
"""

from __future__ import annotations

import json
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ASSET_ROOT = ROOT / "packages/client/src/game.package"
STAGE = ROOT / "packages/client/raw-assets" / "avatars{tps}"

# Manifest ids are lowercase dotted slugs (asset-pipeline.md §2); anything
# else must not reach a Path join (an absolute or dotted id would escape the
# staging dir — security review 2026-08-10).
ID_PATTERN = re.compile(r"[a-z0-9][a-z0-9.-]*\Z")


def _contained(path: Path, root: Path, what: str) -> Path:
    resolved = path.resolve()
    try:
        resolved.relative_to(root.resolve())
    except ValueError:
        raise SystemExit(f"{what} escapes {root}: {path}") from None
    return resolved


def main() -> None:
    if STAGE.exists():
        shutil.rmtree(STAGE)
    STAGE.mkdir(parents=True)
    count = 0
    for manifest_path in sorted(ASSET_ROOT.glob("**/manifest.json")):
        manifest = json.loads(manifest_path.read_text())
        if manifest.get("type") != "avatar-body":
            continue
        asset_id = manifest.get("id", "")
        if ID_PATTERN.fullmatch(asset_id) is None:
            raise SystemExit(f"invalid manifest id {asset_id!r} in {manifest_path}")
        dest = _contained(STAGE / asset_id.replace(".", "_"), STAGE, "staging dir")
        dest.mkdir(parents=True)
        base = manifest_path.parent
        for pose, meta in (manifest.get("poses") or {}).items():
            src = _contained(base / meta["file"], ASSET_ROOT, "pose file")
            if not src.is_file():
                raise SystemExit(f"missing {src}")
            shutil.copy(src, dest / f"{pose}.png")
            count += 1
            # 3rd-layer poses (factory v2 手順 3) ship far/near arm cutouts
            # alongside their armless body frame — stage them too.
            for side, layer in (meta.get("armLayers") or {}).items():
                layer_src = _contained(base / layer["file"], ASSET_ROOT, "arm layer")
                if not layer_src.is_file():
                    raise SystemExit(f"missing {layer_src}")
                shutil.copy(layer_src, dest / f"{pose}-arm-{side}.png")
                count += 1
        hand = manifest.get("handLayer")
        if hand:
            src = _contained(base / hand["file"], ASSET_ROOT, "hand layer")
            if src.is_file():
                shutil.copy(src, dest / "hand.png")
                count += 1
        print(f"staged {manifest['id']} → {dest.relative_to(ROOT)}")
    print(f"{count} files staged under {STAGE.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
