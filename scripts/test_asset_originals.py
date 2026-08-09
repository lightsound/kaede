#!/usr/bin/env python3
"""Regression tests for the asset-original boundary and hash workflow."""

import hashlib
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))

import r2_originals

UPLOADER_SPEC = importlib.util.spec_from_file_location(
    "upload_asset_originals", SCRIPTS / "upload-asset-originals.py"
)
assert UPLOADER_SPEC is not None and UPLOADER_SPEC.loader is not None
uploader = importlib.util.module_from_spec(UPLOADER_SPEC)
UPLOADER_SPEC.loader.exec_module(uploader)


class AssetOriginalBoundaryTests(unittest.TestCase):
    def test_in_tree_parent_alias_is_allowed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "game.package"
            avatar = root / "avatar"
            avatar.mkdir(parents=True)

            resolved = r2_originals.resolve_asset_path(
                avatar, "../avatar/sheet-original.png", root
            )

            self.assertEqual(resolved, avatar / "sheet-original.png")

    def test_absolute_and_outside_paths_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "game.package"
            avatar = root / "avatar"
            avatar.mkdir(parents=True)

            with self.assertRaises(SystemExit):
                r2_originals.resolve_asset_path(avatar, "/tmp/escape.png", root)
            with self.assertRaises(SystemExit):
                r2_originals.resolve_asset_path(avatar, "../../escape.png", root)

    def test_external_symlink_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            root = base / "game.package"
            avatar = root / "avatar"
            outside = base / "outside-original.png"
            avatar.mkdir(parents=True)
            outside.write_bytes(b"outside")
            (avatar / "escape-original.png").symlink_to(outside)

            with self.assertRaises(SystemExit):
                r2_originals.resolve_asset_path(
                    avatar, "escape-original.png", root
                )

    def test_fetch_verifies_hash_before_writing(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "game.package"
            avatar = root / "avatar"
            avatar.mkdir(parents=True)
            body = b"trusted original"
            digest = hashlib.sha256(body).hexdigest()

            with patch.object(r2_originals, "_request", return_value=body):
                r2_originals.fetch_original(
                    avatar, "sheet-original.png", digest, root
                )
            self.assertEqual((avatar / "sheet-original.png").read_bytes(), body)

            with patch.object(r2_originals, "_request", return_value=b"tampered"):
                with self.assertRaises(SystemExit):
                    r2_originals.fetch_original(
                        avatar, "sheet-original.png", digest, root
                    )

    def test_content_key_does_not_depend_on_extension(self) -> None:
        digest = "a" * 64
        self.assertEqual(
            r2_originals.object_key(digest),
            r2_originals.object_key(digest),
        )
        self.assertEqual(r2_originals.object_key(digest), f"originals/{digest}")


class SharedOrderRewriteTests(unittest.TestCase):
    def test_seed_rewrites_all_orders_for_same_resolved_path(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "game.package"
            avatar = root / "avatar"
            carry = root / "avatar-carry"
            avatar.mkdir(parents=True)
            carry.mkdir(parents=True)
            original = avatar / "sheet-original.png"
            original.write_bytes(b"original")

            avatar_order = {
                "sheet": "sheet-original.png",
                "references": [],
                "type": "avatar-body",
                "originals": {},
            }
            carry_order = {
                "sheet": "sheet-original.png",
                "references": ["../avatar/sheet-original.png"],
                "type": "avatar-body",
                "originals": {},
            }
            (avatar / "order.json").write_text(json.dumps(avatar_order))
            (carry / "order.json").write_text(json.dumps(carry_order))

            paths = uploader.seed_paths([avatar / "order.json"], root)
            self.assertEqual(paths, [original])
            with patch.object(uploader, "write_order") as write_order:
                changed = uploader.rewrite_orders(
                    {original: "b" * 64}, root
                )

            self.assertEqual(
                set(changed),
                {avatar / "order.json", carry / "order.json"},
            )
            rewritten = {
                path: order
                for path, (order,) in (
                    (call.args[0], call.args[1:])
                    for call in write_order.call_args_list
                )
            }
            self.assertEqual(
                rewritten[carry / "order.json"]["originals"],
                {"../avatar/sheet-original.png": "b" * 64},
            )


if __name__ == "__main__":
    unittest.main()
