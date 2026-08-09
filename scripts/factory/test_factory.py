#!/usr/bin/env python3
"""Unit tests for the asset factory (foot phase, structure anchors, templates)."""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image, ImageDraw

SCRIPTS = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SCRIPTS))

from factory import templates
from factory.anchors import structure_hand_carry, structure_neck
from factory.art_lint import (
    check_head_consistency,
    check_palette_drift,
    lint_avatar,
    silhouette_iou,
)
from factory.compose_sheet import cut_head, paste_head
from factory.foot_phase import foot_signal, select_walk_indices


def _chibi(neck_y: int = 50, hand: tuple[int, int] | None = None) -> Image.Image:
    """Synthetic chibi silhouette: wide head, pinched neck, narrower torso."""
    img = Image.new("RGBA", (64, 100), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    # Head (wide)
    draw.ellipse((8, 4, 56, neck_y + 4), fill=(240, 200, 160, 255))
    # Neck pinch
    draw.rectangle((28, neck_y, 36, neck_y + 6), fill=(240, 200, 160, 255))
    # Torso
    draw.rectangle((20, neck_y + 6, 44, 78), fill=(240, 200, 160, 255))
    # Legs
    draw.rectangle((22, 78, 30, 98), fill=(240, 200, 160, 255))
    draw.rectangle((34, 78, 42, 98), fill=(240, 200, 160, 255))
    if hand:
        hx, hy = hand
        draw.ellipse((hx - 5, hy - 5, hx + 5, hy + 5), fill=(240, 200, 160, 255))
    return img


class TemplateTests(unittest.TestCase):
    def test_expand_stand(self) -> None:
        text = templates.expand(
            "avatar-stand",
            {
                "subject": "girl",
                "appearance": "Brown hair.",
                "outfit": "a peach camisole and shorts",
            },
        )
        self.assertIn("peach camisole", text)
        self.assertIn("#00FF00", text)

    def test_unknown_template(self) -> None:
        with self.assertRaises(SystemExit):
            templates.expand("nope", {})


class AnchorTests(unittest.TestCase):
    def test_structure_neck_finds_pinch(self) -> None:
        frame = _chibi(neck_y=48)
        x, y = structure_neck(frame)
        self.assertTrue(44 <= y <= 54, f"neck y={y}")
        self.assertTrue(24 <= x <= 40, f"neck x={x}")

    def test_hoodie_wide_neck_fails_loud(self) -> None:
        # A silhouette with no pinch (column) must not silently pick the waist.
        img = Image.new("RGBA", (40, 80), (0, 0, 0, 0))
        draw = ImageDraw.Draw(img)
        draw.rectangle((5, 5, 35, 75), fill=(200, 100, 80, 255))
        with self.assertRaises(SystemExit):
            structure_neck(img)

    def test_carry_hand_on_waist_peak(self) -> None:
        # Mitten pad widens the waist span; detector lands on that peak row.
        frame = _chibi(hand=(32, 64))
        x, y = structure_hand_carry(frame)
        self.assertTrue(24 <= x <= 40, f"hand x={x}")
        self.assertTrue(54 <= y <= 72, f"hand y={y}")

    def test_carry_hand_matches_basic_carry_sheet(self) -> None:
        root = Path(__file__).resolve().parents[2]
        stand = root / "packages/client/src/game.package/avatar-carry/stand.png"
        if not stand.is_file():
            self.skipTest("avatar-carry stand not in workspace")
        x, y = structure_hand_carry(Image.open(stand))
        # Owner-measured mitten top-center is (26, 64); allow a few px.
        self.assertTrue(abs(x - 26) <= 3 and abs(y - 64) <= 3, f"hand={(x, y)}")


class FootPhaseTests(unittest.TestCase):
    def test_foot_signal_sign_follows_leading_foot(self) -> None:
        def frame(lead: str) -> Image.Image:
            img = Image.new("RGBA", (80, 60), (0, 255, 0, 255))
            draw = ImageDraw.Draw(img)
            draw.rectangle((30, 5, 50, 40), fill=(200, 150, 100, 255))  # body
            if lead == "right":
                draw.rectangle((48, 40, 70, 58), fill=(200, 150, 100, 255))
                draw.rectangle((22, 40, 30, 48), fill=(200, 150, 100, 255))
            else:
                draw.rectangle((10, 40, 32, 58), fill=(200, 150, 100, 255))
                draw.rectangle((50, 40, 58, 48), fill=(200, 150, 100, 255))
            return img

        self.assertGreater(foot_signal(frame("right")), 0)
        self.assertLess(foot_signal(frame("left")), 0)

    def test_select_walk_indices_returns_four_distinct(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            paths = []
            for i in range(40):
                # Oscillate which foot leads over a ~16-frame period.
                phase = (i % 16) / 16
                lead = "right" if phase < 0.5 else "left"
                img = Image.new("RGBA", (80, 60), (0, 255, 0, 255))
                draw = ImageDraw.Draw(img)
                draw.rectangle((30, 5, 50, 40), fill=(200, 150, 100, 255))
                if lead == "right":
                    extent = 10 + int(20 * abs(0.25 - (phase % 0.5)) / 0.25)
                    draw.rectangle((48, 40, 48 + extent, 58), fill=(200, 150, 100, 255))
                    draw.rectangle((20, 40, 32, 50), fill=(200, 150, 100, 255))
                else:
                    extent = 10 + int(20 * abs(0.25 - (phase % 0.5)) / 0.25)
                    draw.rectangle((32 - extent, 40, 32, 58), fill=(200, 150, 100, 255))
                    draw.rectangle((48, 40, 60, 50), fill=(200, 150, 100, 255))
                path = Path(temporary) / f"frame_{i:04d}.png"
                img.save(path)
                paths.append(path)
            chosen = select_walk_indices(paths, skip_head_seconds=0.0)
            self.assertEqual(set(chosen), {"walk-a", "walk-b", "walk-c", "walk-d"})
            self.assertEqual(len(set(chosen.values())), 4)


class ArtLintTests(unittest.TestCase):
    def test_lint_passes_every_committed_sheet(self) -> None:
        # The head-consistency and palette-drift gates were calibrated on
        # these four sheets; a threshold change that rejects shipped art
        # must fail here first.
        root = SCRIPTS.parent / "packages/client/src/game.package"
        for name in ("avatar", "avatar-red", "avatar-carry", "avatar-red-carry"):
            failures = lint_avatar(root / name / "manifest.json")
            self.assertEqual(failures, [], name)

    def test_head_consistency_catches_double_head(self) -> None:
        stand = _chibi(neck_y=50)
        double = _chibi(neck_y=50)
        # A second head mass above the real one (the PR #94 walk-a shape).
        ImageDraw.Draw(double).ellipse((10, 0, 54, 30), fill=(90, 60, 40, 255))
        self.assertEqual(check_head_consistency(stand, 50, stand, 50), [])
        self.assertNotEqual(check_head_consistency(stand, 50, double, 50), [])

    def test_head_consistency_catches_neck_row_drift(self) -> None:
        stand = _chibi(neck_y=50)
        failures = check_head_consistency(stand, 50, stand, 50 + 19)
        self.assertTrue(any("neck row drifted" in f for f in failures))

    def test_palette_drift_catches_repainted_limbs(self) -> None:
        stand = _chibi(neck_y=50)
        drifted = _chibi(neck_y=50)
        # Repaint the torso magenta — far from every stand color.
        ImageDraw.Draw(drifted).rectangle((20, 56, 44, 78), fill=(255, 0, 200, 255))
        self.assertEqual(check_palette_drift(stand, stand), [])
        self.assertNotEqual(check_palette_drift(stand, drifted), [])

    def test_silhouette_iou_orders_similarity(self) -> None:
        a = _chibi(neck_y=50)
        shifted = Image.new("RGBA", (64, 100), (0, 0, 0, 0))
        shifted.paste(a.crop((0, 0, 44, 100)), (20, 0))
        self.assertEqual(silhouette_iou(a, a), 1.0)
        self.assertLess(silhouette_iou(a, shifted), 0.8)


class ComposeTests(unittest.TestCase):
    def test_paste_head_replaces_the_video_head(self) -> None:
        # A body whose own (video-drawn) head is wider than the stand head:
        # paste alone leaves it peeking out (the PR #94 double-head /
        # bob-remnant bug); erase-then-paste must remove it entirely.
        stand = _chibi(neck_y=50)
        head, stand_neck_y = cut_head(stand, (32, 50))
        body = _chibi(neck_y=50)
        ImageDraw.Draw(body).ellipse((0, 0, 63, 52), fill=(10, 30, 220, 255))
        out = paste_head(body, head, stand_neck_y, (32, 50))
        remnants = sum(
            1
            for y in range(out.height)
            for x in range(out.width)
            if out.getpixel((x, y))[3] >= 128 and out.getpixel((x, y))[2] > 180
        )
        # The two rows of fake head below the neck row (50..52) are chest
        # territory the composite chin overlap covers; above-neck must be 0.
        self.assertLess(remnants, out.width * 3)
        above_neck = sum(
            1
            for y in range(50)
            for x in range(out.width)
            if out.getpixel((x, y))[3] >= 128 and out.getpixel((x, y))[2] > 180
        )
        self.assertEqual(above_neck, 0)


if __name__ == "__main__":
    unittest.main()
