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
from factory.art_lint import lint_avatar
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

    def test_carry_hand_on_protrusion(self) -> None:
        frame = _chibi(hand=(50, 64))
        x, y = structure_hand_carry(frame)
        self.assertGreater(x, 32)
        self.assertTrue(52 <= y <= 72, f"hand y={y}")


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
    def test_lint_passes_committed_boy_basic(self) -> None:
        root = SCRIPTS.parent / "packages/client/src/game.package"
        failures = lint_avatar(root / "avatar" / "manifest.json")
        self.assertEqual(failures, [])


if __name__ == "__main__":
    unittest.main()
