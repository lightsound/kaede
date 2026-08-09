#!/usr/bin/env python3
"""Upload generation originals to R2 and re-record every order that names them.

Usage:
    python3 scripts/upload-asset-originals.py <order.json>...
    python3 scripts/upload-asset-originals.py --file path/to/rejected-original.png

The CLI arguments are *seeds*: every generation original (`*-original.*`)
those orders name that is present on disk is uploaded once (content-
addressed — r2_originals.py; re-uploading identical bytes overwrites the
same key). The sha256 is then written into the `originals` map of **every**
order under packages/client/src/game.package whose sheet/references resolve
to that same file — not just the seed orders. Shared references
(`../avatar/sheet-original.png` vs `sheet-original.png`) stay consistent
by construction; callers do not have to remember which other orders name
the same bytes (the hard invariant is cross-order).

An original that is already recorded and absent from disk is left alone
(fresh-clone case). An absent, unrecorded one is an error. Unreferenced
generation candidates and rejected variants can be stored with `--file`;
they receive a content-addressed object but no order pointer.

The factory flow (docs/asset-pipeline.md §4): generate into the asset dir
→ run this (any order that names the new file) → this command rewrites all
affected order maps and re-runs their importers so dependent manifests stay
in sync → commit everything except the originals.
"""

import argparse
import fnmatch
import json
import subprocess
import sys
import tempfile
from pathlib import Path

from r2_originals import (
    object_key,
    resolve_asset_path,
    upload_original,
    validate_order_path,
)

ORIGINAL_NAME_PATTERN = "*-original.*"
ASSET_ROOT = Path(__file__).resolve().parent.parent / "packages/client/src/game.package"
IMPORTERS = {
    "avatar-body": "import-avatar-sheet.py",
    "held-item": "import-held-item.py",
}


def is_original(rel: str) -> bool:
    return fnmatch.fnmatch(Path(rel).name, ORIGINAL_NAME_PATTERN)


def original_inputs(order: dict) -> list[str]:
    return [order["sheet"], *order.get("references", [])]


def all_orders(asset_root: Path = ASSET_ROOT) -> list[Path]:
    return [
        validate_order_path(path, asset_root)
        for path in sorted(asset_root.rglob("order.json"))
    ]


def write_order(order_path: Path, order: dict) -> None:
    """Format then atomically replace one order file."""
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=order_path.parent,
            prefix=f".{order_path.name}.",
            suffix=".tmp",
            delete=False,
        ) as handle:
            temporary = Path(handle.name)
            handle.write(json.dumps(order, ensure_ascii=False, indent=2) + "\n")
        # The order is committed data reviewed in PRs: keep it in the repo's
        # one JSON style so this tool never trips `pnpm lint`.
        subprocess.run(["pnpm", "exec", "biome", "format", "--write", str(temporary)], check=True)
        temporary.replace(order_path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("orders", nargs="*", type=Path, help="seed order.json files")
    parser.add_argument(
        "--file",
        dest="files",
        action="append",
        type=Path,
        default=[],
        help="upload an unreferenced original under the asset root",
    )
    args = parser.parse_args()
    if not args.orders and not args.files:
        parser.error("provide at least one order.json or --file")
    return args


def seed_paths(seed_orders: list[Path], asset_root: Path = ASSET_ROOT) -> list[Path]:
    """Resolved on-disk originals named by the seed orders (upload units)."""
    found: dict[Path, None] = {}
    for order_path in seed_orders:
        order_path = validate_order_path(order_path, asset_root)
        order = json.loads(order_path.read_text())
        base = order_path.parent
        recorded = order.get("originals", {})
        for rel in original_inputs(order):
            if not is_original(rel):
                continue
            path = resolve_asset_path(base, rel, asset_root)
            if path.exists():
                found[path] = None
            elif rel not in recorded:
                raise SystemExit(
                    f"{order_path}: {rel} is neither on disk nor recorded — nothing to upload"
                )
    return list(found)


def rewrite_orders(
    hashes_by_path: dict[Path, str], asset_root: Path = ASSET_ROOT
) -> list[Path]:
    """Rewrite all matching order maps, then return affected orders."""
    changed_orders: dict[Path, dict] = {}
    for order_path in all_orders(asset_root):
        order = json.loads(order_path.read_text())
        base = order_path.parent
        originals = dict(order.get("originals", {}))
        changed = False
        for rel in original_inputs(order):
            if not is_original(rel):
                continue
            resolved = resolve_asset_path(base, rel, asset_root)
            sha256 = hashes_by_path.get(resolved)
            if sha256 is None:
                continue
            if originals.get(rel) == sha256:
                continue
            originals[rel] = sha256
            changed = True
            print(f"{order_path}: {rel} -> {object_key(sha256)}")
        if changed:
            order["originals"] = dict(sorted(originals.items()))
            changed_orders[order_path] = order
    # Compute every update before writing any file. Each individual replacement
    # is atomic, so interruption cannot leave malformed JSON and all dependent
    # importers run only after the complete map set is on disk.
    for order_path, order in changed_orders.items():
        write_order(order_path, order)
    return list(changed_orders)


def reimport_orders(order_paths: list[Path]) -> None:
    """Regenerate every manifest whose reference map changed."""
    script_dir = Path(__file__).resolve().parent
    for order_path in order_paths:
        order = json.loads(order_path.read_text())
        importer = IMPORTERS.get(order.get("type"))
        if importer is None:
            raise SystemExit(f"{order_path}: no importer for type {order.get('type')!r}")
        subprocess.run(
            [sys.executable, str(script_dir / importer), str(order_path)],
            check=True,
        )


def main() -> None:
    args = parse_args()
    seed_paths_found = seed_paths(args.orders)
    paths = list(seed_paths_found)
    for file_path in args.files:
        resolved = resolve_asset_path(Path.cwd(), str(file_path), ASSET_ROOT)
        if not resolved.is_file():
            raise SystemExit(f"{file_path} is not a regular file under {ASSET_ROOT}")
        if resolved not in paths:
            paths.append(resolved)
    if not paths:
        return
    hashes_by_path = {
        path: upload_original(path, ASSET_ROOT) for path in paths
    }
    seed_path_set = set(seed_paths_found)
    for path, sha256 in hashes_by_path.items():
        if path not in seed_path_set:
            print(f"{path}: {object_key(sha256)}")
    if args.orders:
        changed_orders = rewrite_orders(hashes_by_path)
        reimport_orders(changed_orders)


if __name__ == "__main__":
    main()
