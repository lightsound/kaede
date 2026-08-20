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

from factory import bone_signature, templates
from factory.anchors import structure_hand_carry, structure_neck
from factory.blink import eye_openness_score, phase_candidates, select_cells
from factory.loop_scan import LOOP_MEAN_MIN, find_loop, verify_loop
from factory.replace_lane import register_overrides, score_forced_period
from factory.spike_r2v_bench import registration_takes, repaint_leg_gap
from factory.art_lint import (
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
    paste_head,
    staticize_carry_sheet,
)
from factory.foot_phase import (
    foot_signal,
    leg_spread,
    select_walk_indices,
    stride_quad,
)
from factory.derive_light_carry import erase_outer_hand


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
        # Owner-measured mitten top-center was (26, 64) on the 2x=96px sheet;
        # the 4x=192px re-import doubles it to (52, 128). Tolerance doubles too.
        self.assertTrue(abs(x - 52) <= 6 and abs(y - 128) <= 6, f"hand={(x, y)}")


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
            "avatar-red-carry",
            "avatar-girl",
            "avatar-pants",
            "avatar-pants-carry",
        ):
            order_path = root / name / "order.json"
            order = json.loads(order_path.read_text())
            failures = run_lint(order_path, order)
            # Known debt: the committed walk sheets predate the prescribed
            # bob (factory v2 step 1 re-scaled the wan-era cells to 4x, it
            # did not re-animate them), so the bob-phase gate rejects them
            # BY DESIGN until the v2 lane re-casts the walk sheets
            # (docs/factory-v2-plan.md 手順 2〜4 — #110 サルベージの裁定).
            # Every other gate must still hold on shipped art.
            failures = [f for f in failures if "bob" not in f]
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

    def test_palette_drift_honors_entry_scoped_distance_ruling(self) -> None:
        # 運転知見 37/39: an owner-ruled, order-recorded `lint.driftMax`
        # threads into the gate as `distance_max` (the girl walk ruling
        # 2026-08-20 — wan-animate-2 shades the camisole past the default 45
        # vs the seedance-era stand). The default stays authoritative for
        # every order without an explicit ruling.
        stand = _chibi(neck_y=50)
        drifted = _chibi(neck_y=50)
        ImageDraw.Draw(drifted).rectangle((20, 56, 44, 78), fill=(255, 0, 200, 255))
        self.assertNotEqual(check_palette_drift(stand, drifted), [])
        self.assertEqual(
            check_palette_drift(stand, drifted, distance_max=999), []
        )

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

    def test_find_loop_honors_calibrated_floor(self) -> None:
        masks = self._masks(20, 90)
        start, period, loop_mean, _ = find_loop(
            masks, min_period=12, max_period=40, loop_mean_min=0.50
        )
        self.assertEqual(period, 20)
        self.assertGreater(loop_mean, 0.94)
        with self.assertRaises(SystemExit):
            find_loop(masks, min_period=12, max_period=40, loop_mean_min=1.1)


class RegisterOverrideTests(unittest.TestCase):
    def test_overrides_record_only_passed_knobs(self) -> None:
        self.assertEqual(register_overrides(None, None), {})
        self.assertEqual(register_overrides(24, None), {"period": 24})
        self.assertEqual(register_overrides(None, 0.93), {"loopMeanMin": 0.93})
        self.assertEqual(
            register_overrides(24, 0.93),
            {"period": 24, "loopMeanMin": 0.93},
        )

    def test_forced_period_clears_and_rejects(self) -> None:
        masks = LoopScanTests()._masks(20, 90)
        start, period, score, closure = score_forced_period(
            masks, 20, LOOP_MEAN_MIN
        )
        self.assertEqual(period, 20)
        self.assertGreater(score, 0.94)
        self.assertGreater(closure, 0.93)
        self.assertLessEqual(start + 2 * period, 90)
        with self.assertRaises(SystemExit):
            score_forced_period(masks, 13, LOOP_MEAN_MIN)


class RegistrationTakeGlobTests(unittest.TestCase):
    def test_crop_and_reg_derivatives_are_excluded(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp)
            (work / "wanimate2r-720p_walk_t1.mp4").write_bytes(b"ok")
            (work / "wanimate2r-720p_walk_t2.mp4").write_bytes(b"ok")
            (work / "wanimate2r-720p_walk_t1_crop.mp4").write_bytes(b"no")
            (work / "wanimate2r-720p_walk_t2_reg.mp4").write_bytes(b"no")
            (work / "wanimate2r-720p_carry_t1.mp4").write_bytes(b"other")
            names = [p.name for p in registration_takes(work, "walk")]
            self.assertEqual(
                names,
                ["wanimate2r-720p_walk_t1.mp4", "wanimate2r-720p_walk_t2.mp4"],
            )


class LegGapRepaintTests(unittest.TestCase):
    def _frame(self, *, gap_white: bool, shirt_white: bool) -> Image.Image:
        """Chibi on chroma green: navy pants + brown shoes, optional white
        wedge between the legs (the residue) and a white shirt hem above
        the grow zone (must stay)."""
        img = Image.new("RGB", (120, 200), (0, 255, 0))
        draw = ImageDraw.Draw(img)
        # Head + torso (subject top ~20) so the 0.80 seed / 0.74 grow
        # zones land on the legs, not the shirt.
        draw.ellipse((40, 20, 80, 60), fill=(240, 200, 160))
        draw.rectangle((45, 58, 75, 95), fill=(250, 250, 250) if shirt_white else (240, 240, 230))
        draw.rectangle((44, 94, 76, 102), fill=(120, 70, 40))  # belt
        draw.rectangle((42, 102, 58, 175), fill=(30, 40, 90))  # left pant
        draw.rectangle((62, 102, 78, 175), fill=(30, 40, 90))  # right pant
        draw.ellipse((38, 168, 60, 188), fill=(90, 55, 30))
        draw.ellipse((60, 168, 82, 188), fill=(90, 55, 30))
        if gap_white:
            draw.rectangle((58, 150, 62, 174), fill=(255, 255, 255))
        return img

    def test_repaint_clears_leg_gap_and_spares_the_shirt(self) -> None:
        before = self._frame(gap_white=True, shirt_white=True)
        after, count = repaint_leg_gap(before)
        self.assertGreater(count, 0)
        a = list(after.getpixel((60, 160)))
        self.assertEqual(a, [0, 255, 0])
        # Shirt hem (above the grow zone) stays white, not chroma-eaten.
        shirt = list(after.getpixel((60, 80)))
        self.assertGreater(shirt[0], 200)
        self.assertGreater(shirt[2], 200)

    def test_clean_gap_is_a_no_op(self) -> None:
        before = self._frame(gap_white=False, shirt_white=True)
        after, count = repaint_leg_gap(before)
        self.assertEqual(count, 0)
        self.assertEqual(list(after.getpixel((60, 80))), list(before.getpixel((60, 80))))


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


class StrideQuadTests(unittest.TestCase):
    def test_anchors_on_spread_max_inside_loop_window(self) -> None:
        # Pre-loop ease-in garbage (frames 0-9 widest) must be ignored: the
        # girl master's committed cells were cut from exactly that region.
        spreads = [90.0] * 10 + [
            30 + 20 * math.sin(2 * math.pi * i / 12) for i in range(40)
        ]
        quad = stride_quad(spreads, 10, 50, 12)
        anchor = quad["walk-a"]
        self.assertGreaterEqual(anchor, 10)
        self.assertEqual(spreads[anchor], max(spreads[10:22]))
        self.assertEqual(
            [quad[p] - anchor for p in ("walk-a", "walk-b", "walk-c", "walk-d")],
            [0, 3, 6, 9],
        )

    def test_rounded_quarters_do_not_drift(self) -> None:
        # period 42: floor quarters land walk-d at +30 (1.5 frames early —
        # the committed carry v2 drift); rounding lands it at +32.
        spreads = [10.0] * 100
        spreads[0] = 50.0
        quad = stride_quad(spreads, 0, 100, 42)
        self.assertEqual(quad["walk-d"] - quad["walk-a"], 32)

    def test_late_anchor_still_fits_two_instance_window(self) -> None:
        spreads = [10.0] * 24
        spreads[11] = 50.0  # anchor at the first period's very end
        quad = stride_quad(spreads, 0, 24, 12)
        self.assertEqual(quad["walk-a"], 11)
        self.assertEqual(quad["walk-d"], 11 + 9)

    def test_window_without_two_instances_fails_loud(self) -> None:
        with self.assertRaises(SystemExit):
            stride_quad([10.0] * 30, 0, 20, 12)


class BobPhaseTests(unittest.TestCase):
    def _lint(self, nfg: dict[str, int]) -> list[str]:
        from factory.art_lint import check_bob_phase

        return check_bob_phase(nfg)

    # The historic shapes below were measured at the 2x=96px sheet scale;
    # they are fed doubled because the gate's ranges are px at the 4x=192px
    # shipping scale (art_lint.BOB_PP_RANGE).

    def test_prescribed_pattern_passes(self) -> None:
        # The wan-era owner-approved boy shape: contacts low, passings high.
        self.assertEqual(
            self._lint({"walk-a": 90, "walk-b": 94, "walk-c": 88, "walk-d": 94}), []
        )

    def test_inverted_girl_shape_fails(self) -> None:
        # The committed girl (NG1): head HIGH on a contact slot.
        failures = self._lint({"walk-a": 94, "walk-b": 88, "walk-c": 90, "walk-d": 96})
        self.assertTrue(any("bob phase broken" in f for f in failures), failures)

    def test_seasick_carry_amplitude_fails(self) -> None:
        # The committed heavy carry (NG2): correct phase, 7px (@96px) amplitude.
        failures = self._lint({"walk-a": 90, "walk-b": 102, "walk-c": 88, "walk-d": 102})
        self.assertTrue(any("amplitude" in f for f in failures), failures)

    def test_frozen_face_fails(self) -> None:
        failures = self._lint({"walk-a": 94, "walk-b": 94, "walk-c": 94, "walk-d": 94})
        self.assertTrue(failures)

    def test_rejected_fix_attempts_fail(self) -> None:
        # PR #108 (a==b: no rise into the first passing) and PR #109 (the
        # second half inverted) both shipped past every then-existing gate.
        pr108 = self._lint({"walk-a": 92, "walk-b": 92, "walk-c": 88, "walk-d": 98})
        pr109 = self._lint({"walk-a": 88, "walk-b": 96, "walk-c": 94, "walk-d": 88})
        self.assertTrue(pr108)
        self.assertTrue(pr109)

    def test_missing_walk_poses_are_ignored(self) -> None:
        self.assertEqual(self._lint({"stand": 94}), [])


class HandOnSkinTests(unittest.TestCase):
    def test_anchor_on_mitten_passes(self) -> None:
        from factory.art_lint import check_hand_on_skin

        frame = _chibi(hand=(32, 64))
        self.assertEqual(check_hand_on_skin(frame, [32, 64]), [])

    def test_anchor_on_clothing_fails(self) -> None:
        from factory.art_lint import check_hand_on_skin

        frame = _chibi()
        ImageDraw.Draw(frame).rectangle((20, 56, 44, 78), fill=(40, 60, 120, 255))
        failures = check_hand_on_skin(frame, [32, 64])
        self.assertTrue(any("no skin" in f for f in failures), failures)


class LegSpreadTests(unittest.TestCase):
    def test_contact_reads_wider_than_passing(self) -> None:
        contact = _chibi()
        draw = ImageDraw.Draw(contact)
        draw.rectangle((0, 78, 63, 99), fill=(0, 0, 0, 0))
        draw.rectangle((6, 78, 16, 98), fill=(240, 200, 160, 255))
        draw.rectangle((48, 78, 58, 98), fill=(240, 200, 160, 255))
        passing = _chibi()
        self.assertGreater(leg_spread(contact), leg_spread(passing) + 15)


class DeriveLightCarryTests(unittest.TestCase):
    SKIN = (230, 190, 150, 255)
    OUTLINE = (30, 20, 20, 255)

    def _two_hand_cell(self) -> Image.Image:
        """Synthetic two-hand carry cell: near hand (left), skin bridge,
        outer hand (right, outlined), and a leg column below the hand band
        — the shirtless worst case the row band exists for."""
        img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
        draw = ImageDraw.Draw(img)
        draw.rectangle((8, 26, 18, 34), fill=self.SKIN)  # near hand
        draw.rectangle((18, 29, 42, 31), fill=self.SKIN)  # bridge
        draw.rectangle((42, 24, 52, 36), fill=self.SKIN)  # outer hand
        draw.rectangle((53, 24, 54, 36), fill=self.OUTLINE)  # its outline ring
        draw.rectangle((44, 36, 46, 55), fill=self.SKIN)  # leg column below band
        return img

    def test_erases_outer_hand_and_ring_only_within_band(self) -> None:
        cell = self._two_hand_cell()
        erased = erase_outer_hand(cell, (47, 30), 30)
        self.assertGreater(erased, 0)
        px = cell.load()
        self.assertEqual(px[47, 30][3], 0, "outer hand must be cleared")
        self.assertEqual(px[53, 30][3], 0, "outer outline ring must be cleared")
        self.assertEqual(px[10, 30], self.SKIN, "near hand (left of cut) survives")
        self.assertEqual(px[24, 30], self.SKIN, "bridge left of cut survives")
        self.assertEqual(px[45, 50], self.SKIN, "leg skin outside ±7 row band survives")

    def test_reoutlines_the_exposed_cut_edge(self) -> None:
        cell = self._two_hand_cell()
        erase_outer_hand(cell, (47, 30), 30)
        edge = cell.load()[29, 30]
        self.assertEqual(edge[3], 255, "cut edge stays opaque")
        self.assertLess(edge[0], 150, "cut edge darkened toward the outline tone")

    def test_no_skin_at_seed_fails_loud(self) -> None:
        blank = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
        with self.assertRaises(SystemExit):
            erase_outer_hand(blank, (30, 30), 20)


class PrescribedBobTests(unittest.TestCase):
    def test_composed_cells_hold_the_two_bump_pattern(self) -> None:
        # Four identical bodies in, prescribed bob out: the head must land
        # LOW on walk-a/c and HIGH on walk-b/d regardless of what the
        # master's own (noise-dominated) bob does — the amplification this
        # replaces turned that noise into the girl's inverted bob.
        from factory.compose_sheet import compose_walk_sheet

        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            stand_path = base / "stand.png"
            _on_green(_chibi(neck_y=50)).save(stand_path)
            walk_paths = {}
            for pose in ("walk-a", "walk-b", "walk-c", "walk-d"):
                path = base / f"{pose}.png"
                _on_green(_chibi(neck_y=50)).save(path)
                walk_paths[pose] = [path]
            out = base / "sheet.png"
            compose_walk_sheet(stand_path, walk_paths, out)

            sheet = Image.open(out).convert("RGBA")
            cell_w = sheet.width // 5
            nfg = {}
            for i, pose in enumerate(("stand", "walk-a", "walk-b", "walk-c", "walk-d")):
                cell = chroma_key(sheet.crop((i * cell_w, 0, (i + 1) * cell_w, sheet.height)))
                cell = cell.crop(content_bbox(cell))
                nfg[pose] = cell.height - structure_neck(cell)[1]
            contact_max = max(nfg["walk-a"], nfg["walk-c"])
            passing_min = min(nfg["walk-b"], nfg["walk-d"])
            self.assertGreater(passing_min, contact_max, nfg)
            values = [nfg[p] for p in ("walk-a", "walk-b", "walk-c", "walk-d")]
            self.assertLessEqual(max(values) - min(values), 6, nfg)


def _on_green(frame: Image.Image) -> Image.Image:
    """A synthetic body on the green canvas compose expects to key."""
    canvas = Image.new("RGBA", (frame.width + 16, frame.height + 8), (0, 255, 0, 255))
    canvas.alpha_composite(frame, (8, canvas.height - frame.height))
    return canvas


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


class MirrorClipTests(unittest.TestCase):
    """walk_lane.mirror_clip — the canon-facing flip for mirrored-lineage
    masters (運転知見 38): every frame in the clip directory must come back
    horizontally mirrored, in place, keeping filenames."""

    def test_mirrors_every_frame_in_place(self) -> None:
        from factory.walk_lane import mirror_clip

        with tempfile.TemporaryDirectory() as tmp:
            frames = Path(tmp)
            for i in range(3):
                img = Image.new("RGBA", (8, 4), (0, 255, 0, 255))
                img.putpixel((0, 1), (255, 0, 0, 255))
                img.save(frames / f"frame_{i:04d}.png")
            count = mirror_clip(frames)
            self.assertEqual(count, 3)
            for i in range(3):
                out = Image.open(frames / f"frame_{i:04d}.png").convert("RGBA")
                self.assertEqual(out.getpixel((7, 1)), (255, 0, 0, 255))
                self.assertEqual(out.getpixel((0, 1)), (0, 255, 0, 255))


class BoneSignatureTests(unittest.TestCase):
    """Synthetic joint-space loops for the 3D-master ledger gates. The real
    calibration lives in bone_signature's module doc (measured GLBs); these
    tests pin the mechanics: closure finds the fundamental, drift fails
    loud, the loop-mean gate rejects coincidental pose matches (運転知見 17)
    and the gait check rejects half/double windows (運転知見 22)."""

    SUB = 4
    PERIOD = 96  # 24 frames on the fine grid

    def _loop_signature(self, n: int = 300) -> np.ndarray:
        i = np.arange(n)[:, None]
        phases = np.linspace(0, np.pi, 8)[None, :]
        return np.sin(2 * np.pi * i / self.PERIOD + phases)

    def test_finds_fundamental_cycle(self) -> None:
        window = bone_signature.scan_fundamental(self._loop_signature(), self.SUB)
        self.assertEqual(window.period, self.PERIOD)
        self.assertLess(window.closure, 0.05)
        self.assertIsNotNone(window.loop_mean)
        self.assertLess(window.loop_mean, 0.05)

    def test_drifting_clip_fails_loud(self) -> None:
        sig = self._loop_signature()
        sig += np.linspace(0, 40, len(sig))[:, None]
        with self.assertRaises(SystemExit):
            bone_signature.scan_fundamental(sig, self.SUB)

    def test_coincidental_pose_match_fails_the_loop_mean_gate(self) -> None:
        # A clean loop under a slow incommensurate envelope: one pair of
        # samples straddles the envelope peak symmetrically, so the
        # single-pair closure matches (≈ one full loop turn at equal
        # amplitude) while the cycle between the two instances drifts —
        # the girl-gangnam shape a closure-only gate would have registered
        # (運転知見 17).
        i = np.arange(400)[:, None]
        phases = np.linspace(0, np.pi, 8)[None, :]
        loop = np.sin(2 * np.pi * i / self.PERIOD + phases)
        envelope = 1 + 0.8 * np.sin(2 * np.pi * i / 250)
        with self.assertRaises(SystemExit) as ctx:
            bone_signature.scan_fundamental(loop * envelope, self.SUB)
        self.assertIn("運転知見 17", str(ctx.exception))

    def _feet(self, n: int = 300) -> tuple[np.ndarray, np.ndarray]:
        """In-place gait: constant lateral stance on x, alternating forward
        swing on y, z quiet — the measured Meshy rig shape."""
        i = np.arange(n)
        swing = np.sin(2 * np.pi * i / self.PERIOD)
        left = np.stack([np.full(n, 0.06), 0.1 * swing, 0.02 * np.cos(2 * np.pi * i / self.PERIOD)], axis=1)
        right = np.stack([np.full(n, -0.06), -0.1 * swing, left[:, 2]], axis=1)
        return left, right

    def test_full_cycle_gait_passes(self) -> None:
        left, right = self._feet()
        metrics = bone_signature.gait_metrics(left, right, 10, self.PERIOD)
        self.assertEqual(metrics.axis, 1)
        self.assertEqual(bone_signature.check_gait(metrics), [])

    def test_half_cycle_window_fails(self) -> None:
        left, right = self._feet()
        metrics = bone_signature.gait_metrics(left, right, 0, self.PERIOD // 2)
        self.assertTrue(
            any("half-cycle" in f or "one-sided" in f for f in bone_signature.check_gait(metrics))
        )

    def test_double_period_window_fails(self) -> None:
        left, right = self._feet()
        metrics = bone_signature.gait_metrics(left, right, 10, 2 * self.PERIOD)
        failures = bone_signature.check_gait(metrics)
        self.assertTrue(failures)
        self.assertEqual(metrics.sign_flips, 4)

    def test_one_sided_gait_fails(self) -> None:
        left, right = self._feet()
        left[:, 1] = 0.2 + 0.05 * np.sin(2 * np.pi * np.arange(len(left)) / self.PERIOD)
        right[:, 1] = 0.0
        metrics = bone_signature.gait_metrics(left, right, 0, self.PERIOD)
        self.assertTrue(
            any("one-sided" in f for f in bone_signature.check_gait(metrics))
        )


if __name__ == "__main__":
    unittest.main()
