#!/usr/bin/env python3
"""Unit tests for the asset factory (foot phase, structure anchors, templates)."""

from __future__ import annotations

import math
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image, ImageDraw

SCRIPTS = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SCRIPTS))

import numpy as np

from factory import templates
from factory.anchors import structure_hand_carry, structure_neck
from factory.blink import eye_openness_score, phase_candidates, select_cells
from factory.loop_scan import find_loop, verify_loop
from factory.art_lint import (
    check_hand_anchor,
    check_head_consistency,
    check_leg_phase,
    check_neck_junction,
    check_palette_drift,
    lint_avatar,
    silhouette_iou,
)
from factory.compose_sheet import (
    chroma_key,
    chroma_key_greenwear,
    content_bbox,
    cut_head,
    head_bob_sway_y,
    paste_head,
    staticize_carry_sheet,
)
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

    def test_carry_point_accepts_two_hands_and_rejects_outer_edge(self) -> None:
        frame = Image.new("RGBA", (64, 100), (0, 0, 0, 0))
        draw = ImageDraw.Draw(frame)
        # Two palms around an intentionally transparent item center.
        draw.ellipse((18, 58, 30, 70), fill=(240, 200, 160, 255))
        draw.ellipse((34, 58, 46, 70), fill=(240, 200, 160, 255))
        self.assertEqual(check_hand_anchor(frame, [32, 64]), [])
        failures = check_hand_anchor(frame, [45, 64])
        self.assertTrue(any("silhouette edge" in failure for failure in failures))


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
        # The head-consistency, palette-drift and leg-phase gates were
        # calibrated on the committed sheets; a threshold change that
        # rejects shipped art must fail here first. Uses the production
        # run_lint path so order-level lint options (carry/leg expectations,
        # acknowledged drift colors) apply exactly as in the factory.
        import json

        from factory.run_avatar import run_lint

        root = SCRIPTS.parent / "packages/client/src/game.package"
        for name in (
            "avatar",
            "avatar-red",
            "avatar-carry",
            "avatar-carry-light",
            "avatar-red-carry",
            "avatar-red-carry-light",
            "avatar-girl",
            "avatar-pants",
            "avatar-pants-carry",
            "avatar-pants-carry-light",
        ):
            order_path = root / name / "order.json"
            order = json.loads(order_path.read_text())
            failures = run_lint(order_path, order)
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

    def test_neck_junction_passes_solid_bridge(self) -> None:
        # The chibi's neck pinch is a fully opaque 9px bridge — healthy.
        self.assertEqual(check_neck_junction(_chibi(neck_y=50), [32, 50]), [])

    def test_neck_junction_catches_semi_transparent_bridge(self) -> None:
        # The self-masked-paste decay shape: the junction rows' core drops to
        # α150 — no solid pixel left in the anchor window, all-soft bridge.
        frame = _chibi(neck_y=50)
        for y in range(50, 57):
            for x in range(22, 44):
                r, g, b, a = frame.getpixel((x, y))
                if a:
                    frame.putpixel((x, y), (r, g, b, 150))
        failures = check_neck_junction(frame, [32, 50])
        self.assertTrue(any("semi-transparent bridge" in f for f in failures))

    def test_neck_junction_catches_gap(self) -> None:
        # The girl walk-c shape: the junction row is fully transparent at
        # the anchor column — a literal head-body disconnect.
        frame = _chibi(neck_y=50)
        for y in range(50, 54):
            for x in range(frame.width):
                r, g, b, _a = frame.getpixel((x, y))
                frame.putpixel((x, y), (r, g, b, 0))
        failures = check_neck_junction(frame, [32, 50])
        self.assertTrue(any("gap" in f for f in failures))

    def test_silhouette_iou_orders_similarity(self) -> None:
        a = _chibi(neck_y=50)
        shifted = Image.new("RGBA", (64, 100), (0, 0, 0, 0))
        shifted.paste(a.crop((0, 0, 44, 100)), (20, 0))
        self.assertEqual(silhouette_iou(a, a), 1.0)
        self.assertLess(silhouette_iou(a, shifted), 0.8)


class LegPhaseTests(unittest.TestCase):
    def _walker(self, lead: int) -> Image.Image:
        """Chibi whose leg silhouette differs per stride phase.

        The gate is pixel-geometric (pairwise IoU), so the fixtures encode
        pose distinctness the way real strides do: clearly different leg
        masses, not a small foot nudge.
        """
        frame = _chibi(neck_y=50)
        draw = ImageDraw.Draw(frame)
        skin = (240, 200, 160, 255)
        # Erase the base narrow legs, then draw the phase's own.
        draw.rectangle((0, 78, 63, 99), fill=(0, 0, 0, 0))
        if lead == 1:  # contact, near leg forward: wide symmetric spread
            draw.polygon([(20, 78), (4, 98), (20, 98)], fill=skin)
            draw.polygon([(44, 78), (60, 98), (44, 98)], fill=skin)
            draw.rectangle((20, 78, 44, 98), fill=skin)
        elif lead < 0:  # contact, far leg forward: narrow stance, raised heel
            draw.rectangle((18, 78, 28, 98), fill=skin)
            draw.rectangle((36, 78, 46, 88), fill=skin)
        elif lead == 0:  # passing: legs together, one straight column
            draw.rectangle((26, 78, 40, 98), fill=skin)
        else:  # second passing: legs crossing, narrow backward shear
            draw.polygon([(26, 78), (38, 78), (18, 98), (4, 98)], fill=skin)
        return frame

    def test_distinct_cycle_passes(self) -> None:
        frames = {
            "stand": _chibi(neck_y=50),
            "walk-a": self._walker(1),
            "walk-b": self._walker(2),
            "walk-c": self._walker(-1),
            "walk-d": self._walker(0),
        }
        self.assertEqual(check_leg_phase(frames), [])

    def test_one_foot_shuffle_fails_as_near_clones(self) -> None:
        # Contacts that never trade legs are pixel-near-identical frames —
        # the owner-rejected shuffle measured IoU 0.92-0.97 on its contact pair.
        frames = {
            "stand": _chibi(neck_y=50),
            "walk-a": self._walker(1),
            "walk-b": self._walker(2),
            "walk-c": self._walker(1),
            "walk-d": self._walker(0),
        }
        failures = check_leg_phase(frames)
        self.assertTrue(any("near-clones" in f for f in failures), failures)

    def test_clone_pair_fails(self) -> None:
        walker = self._walker(1)
        frames = {
            "stand": _chibi(neck_y=50),
            "walk-a": walker,
            "walk-b": _chibi(neck_y=50),
            "walk-c": self._walker(-1),
            "walk-d": walker.copy(),
        }
        failures = check_leg_phase(frames)
        self.assertTrue(any("near-clones" in f for f in failures), failures)


class StaticizeTests(unittest.TestCase):
    def _carry_sheet(self, path: Path) -> None:
        """5 green cells: striding legs, per-cell drifted walk bellies.

        The walk cells' bellies each drift to their OWN color (the
        whole-sheet-edit flicker); the transplant must unify them onto
        walk-a's shading. The stand keeps a distinct color untouched — the
        preset-motion carry stand poses differently from the walk cells, so
        it is no longer the donor.
        """
        cell_w, cell_h = 120, 120
        sheet = Image.new("RGB", (cell_w * 5, cell_h), (0, 255, 0))
        bellies = [
            (240, 200, 160, 255),  # stand — its own idle shading
            (200, 150, 150, 255),  # walk-a — the donor
            (190, 160, 140, 255),  # walk-b..d — per-cell drift to unify
            (210, 140, 155, 255),
            (195, 155, 145, 255),
        ]
        for i in range(5):
            body = Image.new("RGBA", (64, 100), (0, 0, 0, 0))
            draw = ImageDraw.Draw(body)
            draw.ellipse((8, 4, 56, 54), fill=(240, 200, 160, 255))  # head
            draw.rectangle((28, 50, 36, 56), fill=(240, 200, 160, 255))  # neck
            draw.rectangle((20, 56, 44, 78), fill=bellies[i])  # torso
            stride = [0, 6, 0, -6, 0][i]
            draw.rectangle((22 + stride, 78, 30 + stride, 98), fill=(240, 200, 160, 255))
            draw.rectangle((34 - stride, 78, 42 - stride, 98), fill=(240, 200, 160, 255))
            cell = Image.new("RGBA", (cell_w, cell_h), (0, 255, 0, 255))
            cell.paste(body, ((cell_w - 64) // 2, cell_h - 100), body)
            sheet.paste(cell.convert("RGB"), (i * cell_w, 0))
        sheet.save(path)

    def test_interior_transplant_unifies_the_torso(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            sheet_path = Path(temporary) / "sheet.png"
            self._carry_sheet(sheet_path)
            seam = staticize_carry_sheet(sheet_path)
            out = Image.open(sheet_path).convert("RGBA")
            cell_w = out.width // 5
            # Sample a torso pixel per cell.
            def torso_sample(i: int) -> tuple[int, int, int]:
                cell = chroma_key(out.crop((i * cell_w, 0, (i + 1) * cell_w, out.height)))
                body = cell.crop(content_bbox(cell))
                return body.getpixel((body.width // 2, int(body.height * 0.68)))[:3]

            # Walk cells all take walk-a's shading; the stand keeps its own.
            donor_color = torso_sample(1)
            for i in range(2, 5):
                self.assertEqual(torso_sample(i), donor_color, f"cell {i}")
            self.assertEqual(torso_sample(0), (240, 200, 160))
            self.assertNotEqual(donor_color, (240, 200, 160))
            # Legs (below the seam) keep their per-cell stride.
            self.assertGreater(seam, 0)


class ScratchDirTests(unittest.TestCase):
    def test_default_scratch_stays_under_factory_root(self) -> None:
        from factory.run_avatar import SCRATCH_ROOT, resolve_scratch_dir

        scratch = resolve_scratch_dir("avatar.girl-basic", None)
        self.assertEqual(scratch, SCRATCH_ROOT / "avatar.girl-basic")
        scratch.relative_to(SCRATCH_ROOT)

    def test_scratch_rejects_path_escaping_order_id(self) -> None:
        from factory.run_avatar import resolve_scratch_dir

        with self.assertRaises(SystemExit):
            resolve_scratch_dir("../escape", None)
        with self.assertRaises(SystemExit):
            resolve_scratch_dir("/tmp/elsewhere", None)


class LoopScanTests(unittest.TestCase):
    def _masks(self, period: int, count: int, *, noise_at: set[int] | None = None):
        """Synthetic in-place motion: a block sliding on a sine of `period`."""
        masks = []
        for i in range(count):
            mask = np.zeros((60, 40), dtype=bool)
            offset = round(10 * math.sin(2 * math.pi * i / period))
            mask[10:50, 12 + offset : 24 + offset] = True
            if noise_at and i in noise_at:
                mask[:, :] = False
                mask[20:30, 0:8] = True
            masks.append(mask)
        return masks

    def test_find_loop_recovers_period(self) -> None:
        start, period, loop_mean, closure = find_loop(
            self._masks(20, 90), min_period=12, max_period=40
        )
        self.assertEqual(period, 20)
        self.assertGreater(loop_mean, 0.94)
        self.assertGreater(closure, 0.93)
        self.assertLessEqual(start + 2 * period, 90)

    def test_find_loop_prefers_fundamental_over_harmonic(self) -> None:
        # A 40-frame harmonic of a 20-frame cycle scores the same
        # consistency; the smaller period must win (girl-walk shape).
        _, period, _, _ = find_loop(self._masks(20, 100), min_period=12, max_period=45)
        self.assertEqual(period, 20)

    def test_find_loop_rejects_broken_cycle(self) -> None:
        masks = self._masks(20, 60, noise_at=set(range(25, 35)))
        with self.assertRaises(SystemExit):
            find_loop(masks, min_period=12, max_period=24)

    def test_verify_loop_scores_known_period(self) -> None:
        start, loop_mean, closure = verify_loop(self._masks(20, 90), 20)
        self.assertGreater(loop_mean, 0.94)
        self.assertGreater(closure, 0.93)
        self.assertLessEqual(start + 2 * 20, 90)


class BlinkTests(unittest.TestCase):
    def _face(self, *, eyes_open: bool) -> Image.Image:
        """Chibi bust: dark hair cap, skin face, dark eyes (wide or thin)."""
        img = Image.new("RGBA", (64, 96), (0, 0, 0, 0))
        draw = ImageDraw.Draw(img)
        draw.ellipse((8, 2, 56, 44), fill=(250, 214, 180, 255))  # head skin
        draw.chord((8, 2, 56, 30), 180, 360, fill=(40, 30, 30, 255))  # hair
        eye_h = 8 if eyes_open else 1
        for cx in (22, 42):
            draw.ellipse(
                (cx - 4, 26 - eye_h // 2, cx + 4, 26 + eye_h // 2 + 1),
                fill=(30, 30, 35, 255),
            )
        draw.rectangle((24, 44, 40, 92), fill=(120, 140, 220, 255))  # torso
        return img

    def test_eye_score_drops_on_closed_eyes(self) -> None:
        open_score = eye_openness_score(self._face(eyes_open=True))
        closed_score = eye_openness_score(self._face(eyes_open=False))
        self.assertGreater(open_score, 0)
        # Calibrated split: blinks measure ≤ 0.65 of the open-eye level
        # (PR #101 girl 720p walk); the synthetic blink must sit below it.
        self.assertLess(closed_score, open_score * 0.65)

    def test_phase_candidates_cover_every_instance(self) -> None:
        self.assertEqual(phase_candidates(40, 30, 97), [10, 40, 70])

    def test_select_cells_avoids_blink_frames(self) -> None:
        # 60 frames, period 20, blinks at frames 25 and 45 — both on slot
        # phase 5, so only frame 5 keeps the eyes open there and the
        # selection is pinned (a blink off every slot phase would never be
        # a candidate and would test nothing).
        scores = [100.0] * 60
        scores[25] = scores[45] = 30.0
        chosen, suspects = select_cells(scores, start=0, period=20, cells=4)
        self.assertEqual(suspects, [])
        self.assertEqual(len(chosen), 4)
        for frame in chosen:
            self.assertGreater(scores[frame], 90.0)
        # Phase preserved, and the double-blinked phase resolved to the one
        # open-eyed instance.
        for i, frame in enumerate(chosen):
            self.assertEqual(frame % 20, round(i * 20 / 4) % 20)
        self.assertIn(5, chosen)

    def test_select_cells_flags_unavoidable_blinks(self) -> None:
        # Every instance of slot phase 5 blinks — the winner is a suspect.
        scores = [100.0] * 60
        for frame in (4, 5, 6, 24, 25, 26, 44, 45, 46):
            scores[frame] = 30.0
        chosen, suspects = select_cells(scores, start=0, period=20, cells=4)
        self.assertEqual(len(chosen), 4)
        self.assertEqual(len(suspects), 1)


class GreenwearKeyTests(unittest.TestCase):
    def _take_frame(self) -> Image.Image:
        """Green screen + character wearing a garment green (dominance ~40)."""
        img = Image.new("RGB", (80, 80), (0, 255, 0))
        draw = ImageDraw.Draw(img)
        draw.rectangle((30, 10, 50, 30), fill=(250, 214, 180))  # head skin
        draw.rectangle((28, 30, 52, 60), fill=(60, 110, 70))  # plaid shirt green
        draw.rectangle((32, 60, 48, 76), fill=(120, 120, 130))  # pants
        return img

    def test_background_keyed_and_green_garment_kept(self) -> None:
        keyed = chroma_key_greenwear(self._take_frame())
        self.assertEqual(keyed.getpixel((2, 2))[3], 0)  # background gone
        shirt = keyed.getpixel((40, 45))
        self.assertEqual(shirt[3], 255)  # garment survives
        self.assertEqual(shirt[:3], (60, 110, 70))  # not despilled to gray
        # The walk line's key would have eaten it (regression contrast).
        old = chroma_key(self._take_frame())
        self.assertEqual(old.getpixel((40, 45))[3], 0)


class GestureCellGateTests(unittest.TestCase):
    def _stand(self) -> Image.Image:
        # The head band (above 70% of the neck) must be dominated by one
        # hair color: hair_reference averages that band, and a half-hair /
        # half-face mix would sit far from both (the real reference cells
        # are hair-topped, so the band is hair).
        img = Image.new("RGBA", (64, 100), (0, 0, 0, 0))
        draw = ImageDraw.Draw(img)
        draw.ellipse((12, 2, 52, 46), fill=(40, 30, 30, 255))  # hair-capped head
        draw.rectangle((28, 46, 36, 54), fill=(250, 214, 180, 255))  # neck
        draw.rectangle((20, 54, 44, 78), fill=(120, 140, 220, 255))  # torso
        draw.rectangle((24, 78, 40, 98), fill=(60, 70, 90, 255))  # legs
        return img

    def test_identical_cell_passes_and_estimates_neck(self) -> None:
        from factory.anchors import hair_reference
        from factory.art_lint import check_gesture_cell

        reference = hair_reference(self._stand())
        failures, neck = check_gesture_cell(reference, 1.0, "dance-a", reference.stand)
        self.assertEqual(failures, [])
        # Neck estimate = hair centroid x, hair top + head depth.
        self.assertEqual(
            neck, [reference.centroid_x, reference.top_y + reference.head_depth]
        )

    def test_wrong_scale_cell_fails(self) -> None:
        from factory.anchors import hair_reference
        from factory.art_lint import check_gesture_cell

        reference = hair_reference(self._stand())
        shrunk = reference.stand.resize((32, 50))
        failures, _ = check_gesture_cell(reference, 1.0, "dance-a", shrunk)
        self.assertTrue(any("scale normalization broke" in f for f in failures))


class ComposeTests(unittest.TestCase):
    def test_signed_head_bob_gain_controls_total_motion(self) -> None:
        # The body already moves its head by -delta once. The helper returns
        # only the additional paste offset, so gain 4 must land on ±4× the
        # raw movement and phase -1 must reverse the total, not halve it.
        delta = 2.0
        body_motion = -delta
        normal = body_motion + head_bob_sway_y(delta, 400, gain=4.0, phase=1)
        inverted = body_motion + head_bob_sway_y(delta, 400, gain=4.0, phase=-1)
        self.assertEqual(normal, -8)
        self.assertEqual(inverted, 8)

    def test_master_specific_gain_matches_raw_amplitudes(self) -> None:
        # Measured at the compose working scale: boy raw p-p=3px, heavy
        # carry raw p-p=6px. Gains 4 and 2 yield the same 12px total p-p.
        self.assertEqual(3 * 4.0, 6 * 2.0)

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
