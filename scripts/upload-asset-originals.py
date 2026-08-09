#!/usr/bin/env python3
"""Upload generation originals to R2 and re-record every order that names them.

Usage:
    python3 scripts/upload-asset-originals.py <order.json>...

The CLI arguments are *seeds*: every generation original (`*-original.*`)
those orders name that is present on disk is uploaded once (content-
addressed — r2_originals.py; re-uploading identical bytes overwrites the
same key). The sha256 is then written into the `originals` map of **every**
order under packages/client/src/game.package whose sheet/references resolve
to that same file — not just the seed orders. Shared references
(`../avatar/sheet-original.png` vs `sheet-original.png`) stay consistent
by construction; callers do not have to remember which other orders name
the same bytes (thermos / Pullfrog: the hard invariant is cross-order).

An original that is already recorded and absent from disk is left alone
(fresh-clone case). An absent, unrecorded one is an error.

The factory flow (docs/asset-pipeline.md §4): generate into the asset dir
→ run this (any order that names the new file) → run the import script
→ commit everything except the originals.
"""

import fnmatch
import json
import subprocess
import sys
from pathlib import Path

from r2_originals import object_key, upload_original

ORIGINAL_NAME_PATTERN = "*-original.*"
ASSET_ROOT = Path(__file__).resolve().parent.parent / "packages/client/src/game.package"


def is_original(rel: str) -> bool:
    return fnmatch.fnmatch(Path(rel).name, ORIGINAL_NAME_PATTERN)


def original_inputs(order: dict) -> list[str]:
    return [order["sheet"], *order.get("references", [])]


def all_orders() -> list[Path]:
    return sorted(ASSET_ROOT.rglob("order.json"))


def write_order(order_path: Path, order: dict) -> None:
    order_path.write_text(json.dumps(order, ensure_ascii=False, indent=2) + "\n")
    # The order is committed data reviewed in PRs: keep it in the repo's one
    # JSON style so this tool never trips `pnpm lint` (the import scripts'
    # manifest rule).
    subprocess.run(["pnpm", "exec", "biome", "format", "--write", str(order_path)], check=True)


def seed_paths(seed_orders: list[Path]) -> list[Path]:
    """Resolved on-disk originals named by the seed orders (upload units)."""
    found: dict[Path, None] = {}
    for order_path in seed_orders:
        order = json.loads(order_path.read_text())
        base = order_path.parent
        recorded = order.get("originals", {})
        for rel in original_inputs(order):
            if not is_original(rel):
                continue
            path = (base / rel).resolve()
            if path.exists():
                found[path] = None
            elif rel not in recorded:
                raise SystemExit(
                    f"{order_path}: {rel} is neither on disk nor recorded — nothing to upload"
                )
    return list(found)


def rewrite_orders(resolved: Path, sha256: str) -> None:
    """Stamp `sha256` into every order whose inputs resolve to `resolved`."""
    for order_path in all_orders():
        order = json.loads(order_path.read_text())
        base = order_path.parent
        originals = dict(order.get("originals", {}))
        changed = False
        for rel in original_inputs(order):
            if not is_original(rel):
                continue
            if (base / rel).resolve() != resolved:
                continue
            if originals.get(rel) == sha256:
                continue
            originals[rel] = sha256
            changed = True
            print(f"{order_path}: {rel} -> {object_key(sha256, rel)}")
        if not changed:
            continue
        order["originals"] = dict(sorted(originals.items()))
        write_order(order_path, order)


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    seeds = [Path(arg) for arg in sys.argv[1:]]
    paths = seed_paths(seeds)
    if not paths:
        return
    for path in paths:
        sha256 = upload_original(path)
        rewrite_orders(path, sha256)


if __name__ == "__main__":
    main()
