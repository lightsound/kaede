#!/usr/bin/env python3
"""Upload an order's generation originals to R2 and record their hashes.

Usage:
    python3 scripts/upload-asset-originals.py <order.json>...

For each order file, every input the order names (the `sheet` plus every
`references` entry) whose file name matches `*-original.*` is a generation
original (the naming convention of the asset dirs; such files are
gitignored — ROADMAP Phase 5 ①b⑶). Each one present on disk is uploaded
to the content-addressed store (r2_originals.py; re-uploading identical
bytes overwrites the same key, so the command is idempotent) and its
sha256 recorded in the order's `originals` map — the pointer the import
scripts resolve once the local copy is gone. An absent original that is
already recorded is left alone; an absent, unrecorded one is an error.

The factory flow (docs/asset-pipeline.md §4): generate into the asset dir
→ run this → run the import script (its manifest embeds the same hashes)
→ commit everything except the originals.
"""

import fnmatch
import json
import subprocess
import sys
from pathlib import Path

from r2_originals import object_key, upload_original

ORIGINAL_NAME_PATTERN = "*-original.*"


def is_original(rel: str) -> bool:
    return fnmatch.fnmatch(Path(rel).name, ORIGINAL_NAME_PATTERN)


def process_order(order_path: Path) -> None:
    order = json.loads(order_path.read_text())
    base = order_path.parent
    originals = dict(order.get("originals", {}))
    for rel in [order["sheet"], *order.get("references", [])]:
        if not is_original(rel):
            continue
        path = base / rel
        if not path.exists():
            if rel in originals:
                continue
            raise SystemExit(f"{order_path}: {rel} is neither on disk nor recorded — nothing to upload")
        sha256 = upload_original(path)
        originals[rel] = sha256
        print(f"{order_path}: {rel} -> {object_key(sha256, rel)}")
    if not originals:
        return
    order["originals"] = dict(sorted(originals.items()))
    order_path.write_text(json.dumps(order, ensure_ascii=False, indent=2) + "\n")
    # The order is committed data reviewed in PRs: keep it in the repo's one
    # JSON style so this tool never trips `pnpm lint` (the import scripts'
    # manifest rule).
    subprocess.run(["pnpm", "exec", "biome", "format", "--write", str(order_path)], check=True)


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    for arg in sys.argv[1:]:
        process_order(Path(arg))


if __name__ == "__main__":
    main()
