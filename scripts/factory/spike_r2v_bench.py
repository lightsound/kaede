#!/usr/bin/env python3
"""Factory v2 steps 4a/4b spike: fal-hosted layer-2 bench (docs/
factory-v2-plan.md §7 結論 3 — the layer-2 shootout's zero-setup bracket).

Baseline = the current v1 lane (wan-2.2 animate/replace 720p, the recast
form: 3D green reference × the committed boy stand cell). Challengers = the
r2v generation hosted on fal (wan 2.7 r2v 1080p / MiniMax H3 r2v 768p /
seedance 2.5 r2v / Kling o3 pro r2v), plus two contrast paradigms:
wan 2.7 edit-video (repaint the green reference into the kaede style
instead of transplanting an identity) and fal-ai/scail-2 (hosted after
all). SeedVR2 video upscaling rides as an independent post-stage lever on
promising outputs. Step 4b (2026-08-18 — §7 残タスク 3 の前提更新) adds
the fal-hosted `fal-ai/wan-animate-2` lanes: a single endpoint (no v1
move/replace split) whose llms.txt pricing is UNSET ("$0 per compute
seconds"), so a 480p probe's balance delta calibrates the estimates
before any full-price take. The bench never touches the ledgers — its
output is owner-judgment material only.

Every lane gets the SAME inputs: the ledger's green reference
(master_models.json boy walk 68f554… / walk-carry — 4a used the
pre-correction f090cc…, 4b uses the CURRENT canonical head-raised
155a7af8…) trimmed to two bone-verified cycles (wan 2.7 r2v and seedance
bill input video seconds), and the identity standard of the adopted
masters (R2 original stand cell → SeedVR2 4x → white square — 運転知見
33; 4a lanes predating that standard used the un-upscaled square). Money
mechanics ride fal_client.FalJobs unchanged (state-persisted keys —
re-runs never re-spend, --budget stop) plus a live fal-balance floor
check before every submission, plus a per-run balance-delta record
(billing.json) — the fal balance API is the only true cost reading
(BYOK gateway logs report cost=0 — 運転知見 31).

Analysis is comparative, not gating (the bench verdict is the owner's):
chroma-key aptitude (green-border fraction), loop closure and measured
period vs the reference's cycle seconds (period inheritance — r2v models
are NOT frame-synced, unlike replace; whether wan-animate-2 frame-syncs
is a 4b measurement), and PR #98-style verdict material plus the 運転知見
34 judgment sheets (every row labeled with model / resolution / inputs /
measured cost, ground truth first, adopted-master rows for the win/loss
call).

Usage:
    export CLOUDFLARE_API_TOKEN=...
    python3 scripts/factory/spike_r2v_bench.py <workdir> prepare
    python3 scripts/factory/spike_r2v_bench.py <workdir> run \
        --lane wanimate2-480p --motion walk [--take 1] [--budget 4.0]
    python3 scripts/factory/spike_r2v_bench.py <workdir> seedvr \
        --source <lane>:<motion>[:take] [--factor 2] [--budget 4.0]
    python3 scripts/factory/spike_r2v_bench.py <workdir> analyze
    python3 scripts/factory/spike_r2v_bench.py <workdir> material
    python3 scripts/factory/spike_r2v_bench.py <workdir> judgment
    python3 scripts/factory/spike_r2v_bench.py <workdir> upload
    python3 scripts/factory/spike_r2v_bench.py <workdir> costs
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

from factory import fal_client  # noqa: E402
from factory.art_lint import check_palette_drift  # noqa: E402
from factory.compose_sheet import chroma_key_greenwear, content_bbox  # noqa: E402
from factory.loop_scan import (  # noqa: E402
    best_loop_start,
    mask_iou,
    silhouette_mask,
)
from factory.verdict_material import (  # noqa: E402
    loop_video,
    montage_rows,
    preview_cells,
    scaled,
)
from factory.video import extract_frames, probe, run_quiet, trim  # noqa: E402
from r2_originals import get_object, put_object  # noqa: E402

# Inputs are pinned by content address (master_models.json boy motions +
# the v1 720p recast take that survived PR #116's rollback in R2).
GREEN_REFS = {
    "walk": {
        "sha256": "68f5542a18be188ff3080d4102b80b2bfdf990e5bf193c63defcec726d04d9a7",
        "loopStart": 2,
        "period": 25,
    },
    "carry": {
        "sha256": "f090cc5c69d69fcb4333c2cc03a5f0efb77ddcada3c5e060696a96000cc4ce18",
        "loopStart": 1,
        "period": 24,
    },
}
V1_CARRY_TAKE = "fb6d4ef63a349d871f62933447bda9ffd6376d7d6791fc2aab044daac030800d"
# Head-raised carry reference (Head X-20 via bpy_pose_offset — the adopted
# carry master's motion source, ledger boy/walk-carry as of 2026-08-16).
HEADUP_REF = {
    "sha256": "155a7af828a34835d33069d112e59093fc16c1a220f2a0699e46862daeaf84f6",
    "loopStart": 5,
    "period": 24,
}
# Identity source is the R2 ORIGINAL sheet (運転知見 32 — the shipped 192px
# cell must never be an identity input; the original's stand cell measures
# ~380x418). The sha comes from the committed avatar order's originals map.
IDENTITY_SHEET_SHA256 = (
    "6cceff101abf66034f89ad98facf725300417347f623aad0bf084f89bd123f12"
)
IDENTITY_SHEET_COLS = 5
# Identity-resolution A/B (owner-approved 2026-08-15): the boy's hi-res
# A-pose original (784x1355 — the Tripo round-3 input, an existing R2
# asset) rides the first 720p master-minting take as the alternate
# identity, against the 400px original stand cell.
APOSE_SHA256 = (
    "9c9a6917bb3479566cb0b9f88266ef58901d249e72eb21b38373ea60e5102182"
)
# Machine floor for identity inputs — a low-res identity uniformly degrades
# every lane's redraw and understates the whole bench (運転知見 32 ②).
IDENTITY_MIN_HEIGHT = 300
# The adopted masters' identity input (R2 original stand cell → SeedVR2 4x →
# white square, 1600² — 運転知見 33). Content-addressed in R2, so fetching it
# beats re-upscaling: $0 and byte-identical to the adopted walk master's
# actual input; `upscale-identity` stays as the regeneration path.
UPSCALED_IDENTITY_SHA256 = (
    "c7b3f9049161e4acbfb09bf3d43c92b295d7ee7148922b25c39f0b66b179ae0b"
)
# The win/loss anchors (master_takes.json 2026-08-16): the bench challenges
# these, and the judgment sheets carry them as labeled rows. Fetched read-only
# — this spike never writes a ledger.
ADOPTED_MASTERS = {
    "walk": {
        "sha256": "ea621ba6fa7b1a3d9cc4b62737352d179628b8c7f64c861ea1f96a3a89488725",
        "recipe": "seedance 2.5 r2v 720p (960²)・駆動=台帳緑参照 2 周期・"
        "identity=SeedVR2 4x 立ちセル・実測 $2.45/テイク (2026-08-16 採用)",
    },
    "carry": {
        "sha256": "6a8bd7bc7e1f54532a3cf92cb22e9f9c77fe6013d03188aabfd563e5e5751e2c",
        "recipe": "seedance 2.5 r2v 480p (640²)・駆動=頭起こし補正参照 2 周期・"
        "identity=SeedVR2 4x 立ちセル・実測 $1.09/テイク (2026-08-16 採用)",
    },
}
# The 4a′ v1-replace walk baseline (R2 — correct identity inputs, $0.25
# measured 2026-08-15). Rides the walk judgment sheet as the v1 reference
# row without re-spending.
V1_WALK_TAKE = (
    "b267d7f1c25ba8d38873ab83f3bc211b845611a40335b10e54600a8a7cad7cff"
)
REF_FPS = 24
# Keep at least this much fal balance unspent — a lane that would dip below
# it stops the bench instead of stranding a half-billed queue job.
BALANCE_FLOOR = 0.20
GAME_PREVIEW_HEIGHT = 192

# 運転知見 32 ①: the prompt must NOT describe the character's appearance
# (hair, outfit, colors) — the identity image is the only appearance
# authority. A wrong hand-written description measurably OVERRIDES the
# image on text-following models (seedance 2.5, 2026-08-15) and inverts
# the identity verdict.
STYLE = (
    "EXACTLY the character shown in the reference image — do not change "
    "his hairstyle, face, outfit, colors or proportions. Soft chibi anime "
    "style with clean outlines"
)
MOTION_TEXT = {
    "walk": "walking in place with strictly alternating legs and "
    "opposite-phase arm swing",
    "carry": "walking in place holding both hands still in front of the "
    "belly as if carrying something, legs strictly alternating",
}


def r2v_prompt(motion: str, image_ref: str, video_ref: str, *, side_lock: bool = False) -> str:
    # side_lock: viewpoint language ONLY (appearance words stay banned —
    # 運転知見 32). Counters the frontal drift a frontal identity image
    # induces (運転知見 33).
    side = (
        f" STRICT right-facing 3/4 side view with EXACTLY the same camera "
        f"angle as {video_ref} — a side-scrolling game sprite view. The "
        "character must NEVER face or turn toward the camera."
        if side_lock else ""
    )
    return (
        f"{image_ref} is the character: {STYLE}. {video_ref} is the motion "
        f"reference: an untextured 3D mannequin {MOTION_TEXT[motion]}. "
        f"Recreate the video with the character from {image_ref} performing "
        "EXACTLY the same motion, pose timing and cycle rhythm as "
        f"{video_ref}.{side} Full body always visible, the character stays "
        "centered and does not travel across the frame. Flat pure green "
        "#00FF00 chroma-key background, no shadows, no ground line, no "
        "props, static camera, no cuts, no camera motion."
    )


# wan-animate-2's prompt spec is "appearance and background" — appearance
# stays out (運転知見 32: the identity image is the only appearance
# authority), so only the background side is written. The green statement
# keeps chroma-key aptitude measurable whichever source (white identity
# square vs green driving video) the model takes its background from.
WANIMATE2_PROMPT = (
    "Flat pure green #00FF00 chroma-key background, no shadows, no ground "
    "line, no props."
)
# Owner-ordered controlled deviation (2026-08-19): the carry pose carries an
# item on open hands, so palms must read as UP — or the hands must be
# orientation-less mittens (the identity's chibi hands). The driving video's
# texting-pose hands are flat/inward, so neither gacha nor the motion source
# provides palm-up; the mitten wording is a deliberate appearance override
# (the 運転知見 32 lever, used ON PURPOSE and only with guidance_scale > 1 —
# the distilled CFG-free default provably ignores prompts).
MITTEN_PROMPT = (
    " Both hands are simple smooth rounded mitten-shaped stubby hands with "
    "no individual fingers, no fingernails and no palm lines, exactly like "
    "the tiny rounded hands in the reference image."
)
MITTEN_NEGATIVE = (
    "realistic detailed hands, individual fingers, fingernails, palm lines, "
    "white ghost shapes, floating objects, extra limbs"
)
# llms.txt pricing is UNSET ("$0 per compute seconds" — 2026-08-18), so the
# unit price was unknown until measured by balance delta (the charge settles
# ~2 minutes AFTER completion): 480p 2-cycle $0.052 / 720p $0.140 at the
# distilled default, ~linear in steps (720p steps30 $0.364), guidance 2
# ×1.77 (480p steps20 $0.088 → $0.155 measured). Estimates carry ~15%
# headroom over those actuals — enough over-counting for the budget/floor
# stops without blocking runs the balance can afford.
WANIMATE2_EST = {"480p": 0.06, "580p": 0.11, "720p": 0.16}

EDIT_PROMPT = (
    "Repaint the untextured gray 3D mannequin as {style}. Keep every "
    "frame's body pose, limb positions, motion and timing EXACTLY "
    "unchanged. Keep the flat pure green #00FF00 chroma-key background "
    "unchanged and empty, no shadows, no ground line, static camera."
)
SCAIL_PROMPT = (
    "{style}, {motion}, full body, centered, on a flat pure green #00FF00 "
    "chroma-key background, no shadows, no ground line, static camera."
)


def balance() -> float:
    response = fal_client.gateway(
        "GET", "https://rest.fal.ai/billing/user_balance"
    )
    response.raise_for_status()
    return float(response.text.strip().strip('"'))


def manifest_path(work: Path) -> Path:
    return work / "inputs.json"


def load_manifest(work: Path) -> dict:
    path = manifest_path(work)
    if not path.exists():
        raise SystemExit(f"{path} missing — run `prepare` first")
    return json.loads(path.read_text())


# ---------------------------------------------------------------- prepare


def cmd_prepare(work: Path) -> None:
    manifest: dict = {"motions": {}, "identity": {}}
    for motion, meta in GREEN_REFS.items():
        raw = work / f"ref_{motion}.mp4"
        if not raw.exists():
            raw.write_bytes(get_object(meta["sha256"]))
        info = probe(raw)
        # Two bone-verified cycles: the shortest window that (a) clears the
        # 2 s input minimum of wan edit-video / H3 / seedance, and (b) holds
        # two loop instances so closure is measurable on frame-synced lanes.
        start = meta["loopStart"]
        end = start + 2 * meta["period"] - 1
        trimmed = work / f"ref_{motion}_2cycles.mp4"
        if not trimmed.exists():
            trim(raw, start, end, info.fps, trimmed)
        tinfo = probe(trimmed)
        print(f"{motion}: ref {info.frames}f -> trim {tinfo.frames}f "
              f"({tinfo.duration:.2f}s), period {meta['period']}f")
        manifest["motions"][motion] = {
            **meta,
            "trim": trimmed.name,
            "trimFrames": tinfo.frames,
            "trimSeconds": tinfo.duration,
        }
    v1_carry = work / "v1_carry_720p.mp4"
    if not v1_carry.exists():
        v1_carry.write_bytes(get_object(V1_CARRY_TAKE))
    manifest["v1CarrySha256"] = V1_CARRY_TAKE

    # The adopted carry master's motion source (head-raised re-render) —
    # trimmed the same two-cycle way so the headup lane is CLI-reachable.
    headup_raw = work / "ref_carry_headup.mp4"
    if not headup_raw.exists():
        headup_raw.write_bytes(get_object(HEADUP_REF["sha256"]))
    headup_trim = work / "ref_carry_headup_2cycles.mp4"
    if not headup_trim.exists():
        start = HEADUP_REF["loopStart"]
        trim(headup_raw, start, start + 2 * HEADUP_REF["period"] - 1,
             probe(headup_raw).fps, headup_trim)
    manifest["headupRef"] = {**HEADUP_REF, "trim": headup_trim.name}

    # Identity: the stand cell cut from the R2 ORIGINAL sheet (green-backed
    # 5-cell row), keyed, content-cropped, white-composited and squared (the
    # replace lane's squarify precedent).
    sheet_path = work / "identity_sheet_original.png"
    if not sheet_path.exists():
        sheet_path.write_bytes(get_object(IDENTITY_SHEET_SHA256))
    sheet = Image.open(sheet_path).convert("RGBA")
    stand_canvas = sheet.crop((0, 0, sheet.width // IDENTITY_SHEET_COLS, sheet.height))
    cell = chroma_key_greenwear(stand_canvas)
    cell = cell.crop(content_bbox(cell))
    if cell.height < IDENTITY_MIN_HEIGHT:
        raise SystemExit(
            f"identity cell is {cell.height}px tall (< {IDENTITY_MIN_HEIGHT}) "
            "— a shipped/downscaled cell slipped in; use the R2 original "
            "(運転知見 32)"
        )
    cell.save(work / "identity_cell.png")  # keyed RGBA — the palette anchor
    side = max(cell.size)
    canvas = Image.new("RGBA", (side, side), (255, 255, 255, 255))
    canvas.paste(cell, ((side - cell.width) // 2, side - cell.height), cell)
    identity = canvas.convert("RGB")
    identity_path = work / "identity_square.png"
    identity.save(identity_path)
    manifest["identity"] = {
        "file": identity_path.name,
        "size": identity.size,
        "sheetSha256": IDENTITY_SHEET_SHA256,
    }
    manifest_path(work).write_text(json.dumps(manifest, indent=1) + "\n")

    # Input preflight (運転知見 32): the exact prompts and a zoomed identity
    # ship as verdict material, so a prompt-vs-image contradiction is
    # visible BEFORE any paid run and in the PR.
    zoom = identity.resize((identity.width * 2, identity.height * 2), Image.NEAREST)
    montage_rows([[identity.convert("RGBA"), zoom.convert("RGBA")]],
                 work / "identity_preflight.png")
    prompts = [f"[style]\n{STYLE}\n"]
    for motion in GREEN_REFS:
        prompts.append(f"[r2v/{motion}]\n{r2v_prompt(motion, '<image>', '<video>')}\n")
        prompts.append(f"[scail/{motion}]\n"
                       f"{SCAIL_PROMPT.format(style=STYLE, motion=MOTION_TEXT[motion])}\n")
    prompts.append(f"[edit]\n{EDIT_PROMPT.format(style=STYLE)}\n")
    (work / "prompt_preflight.txt").write_text("\n".join(prompts))
    print(f"prepared inputs — identity {identity.size} (cell {cell.size}), "
          f"preflight written, balance ${balance():.2f}")


# -------------------------------------------------------------------- run


def lane_request(
    lane: str, motion: str, manifest: dict, jobs: fal_client.FalJobs, work: Path,
    *, steps: int | None = None, guidance: float | None = None,
    mitten: bool = False, seed: int | None = None,
) -> tuple[str, dict, float]:
    """(model id, payload, estimated USD) for one lane × motion. steps,
    guidance and seed are wan-animate-2 knobs (mannequin-ghost mitigation
    probes — the distilled default is steps 10 / guidance-free); anything
    else rejects them so a knobbed take can never masquerade as a default
    one."""
    meta = manifest["motions"][motion]
    ref = jobs.upload(work / meta["trim"])
    identity = jobs.upload(work / manifest["identity"]["file"])
    in_s = meta["trimSeconds"]
    if lane == "v1-replace":
        return (
            "fal-ai/wan/v2.2-14b/animate/replace",
            {"video_url": ref, "image_url": identity, "resolution": "720p"},
            meta["trimFrames"] / 16 * 0.08,
        )
    if lane == "wan27-r2v":
        return (
            "fal-ai/wan/v2.7/reference-to-video",
            {
                "prompt": r2v_prompt(motion, "the reference image", "the reference video"),
                "reference_image_urls": [identity],
                "reference_video_urls": [ref],
                "resolution": "1080p",
                "aspect_ratio": "1:1",
                "duration": 3,
            },
            (in_s + 3) * 0.10,
        )
    if lane == "h3-r2v":
        return (
            "minimax/h3/reference-to-video",
            {
                "prompt": r2v_prompt(motion, "Image 1", "Video 1"),
                "reference_image_urls": [identity],
                "reference_video_urls": [ref],
                "resolution": "768P",
                "duration": 5,
                "enable_prompt_expansion": False,
            },
            # Input video seconds bill too: $0.57 measured vs the 5s-output
            # nominal $0.40 (運転知見 31).
            (in_s + 5) * 0.08,
        )
    if lane == "seedance25-r2v-720p-apose":
        apose_raw = work / "identity_apose.png"
        if not apose_raw.exists():
            apose_raw.write_bytes(get_object(APOSE_SHA256))
        img = Image.open(apose_raw).convert("RGB")
        if img.height < IDENTITY_MIN_HEIGHT:
            raise SystemExit(f"A-pose is {img.height}px tall — not the hi-res original")
        side = max(img.size)
        canvas = Image.new("RGB", (side, side), (255, 255, 255))
        canvas.paste(img, ((side - img.width) // 2, (side - img.height) // 2))
        apose_path = work / "identity_apose_square.png"
        canvas.save(apose_path)
        return (
            "bytedance/seedance-2.5/reference-to-video",
            {
                "prompt": r2v_prompt(motion, "@Image1", "@Video1"),
                "image_urls": [jobs.upload(apose_path)],
                "video_urls": [ref],
                "resolution": "720p",
                "aspect_ratio": "1:1",
                "duration": "4",
                "generate_audio": False,
            },
            1.09 * 2.25,
        )
    if lane in ("seedance25-r2v-720p-apose-side", "seedance25-r2v-720p-dual"):
        # 運転知見 33 の正面化対策 2 経路(オーナー指示 2026-08-15):
        # apose-side = A ポーズ identity + 視点ロック文言のみ。
        # dual = @Image1 A ポーズ(見た目) + @Image2 stand(視点)の 2 枚条件付け。
        apose_path = work / "identity_apose_square.png"
        if not apose_path.exists():
            raise SystemExit("run the apose lane once first (prepares the square)")
        if lane == "seedance25-r2v-720p-apose-side":
            prompt = r2v_prompt(motion, "@Image1", "@Video1", side_lock=True)
            images = [jobs.upload(apose_path)]
        else:
            upid = work / "identity_upscaled_square.png"
            prompt = (
                f"@Image1 defines the character. @Image2 shows the SAME "
                f"character from the correct right-facing 3/4 camera angle "
                f"— match this viewpoint EXACTLY. "
                + r2v_prompt(motion, "@Image1", "@Video1", side_lock=True)
            )
            images = [jobs.upload(apose_path), jobs.upload(upid)]
        return (
            "bytedance/seedance-2.5/reference-to-video",
            {
                "prompt": prompt,
                "image_urls": images,
                "video_urls": [ref],
                "resolution": "720p",
                "aspect_ratio": "1:1",
                "duration": "4",
                "generate_audio": False,
            },
            1.09 * 2.25,
        )
    if lane == "seedance25-r2v-headup":
        # Head-raised carry remake (owner order 2026-08-16): the Texting_Walk
        # motion GLB with Head X-20 composed in (bpy_pose_offset.py), re-cast
        # at the owner-chosen cheap tier (480p) with the upscaled stand
        # identity (the adopted walk recipe's identity).
        headup_ref = work / "ref_carry_headup_2cycles.mp4"
        upid = work / "identity_upscaled_square.png"
        for path in (headup_ref, upid):
            if not path.exists():
                raise SystemExit(f"{path.name} missing — prepare it first")
        return (
            "bytedance/seedance-2.5/reference-to-video",
            {
                "prompt": r2v_prompt(motion, "@Image1", "@Video1"),
                "image_urls": [jobs.upload(upid)],
                "video_urls": [jobs.upload(headup_ref)],
                "resolution": "480p",
                "aspect_ratio": "1:1",
                "duration": "4",
                "generate_audio": False,
            },
            1.09,
        )
    if lane == "seedance25-r2v-720p-upid":
        # Both-worlds lever ① (運転知見 33): the stand identity upscaled 4x
        # by SeedVR2 image (pose unchanged — right-3/4 is preserved by
        # construction; only the detail gain is under test).
        upid = work / "identity_upscaled_square.png"
        if not upid.exists():
            raise SystemExit(
                "identity_upscaled_square.png missing — run the SeedVR2 "
                "image upscale step first"
            )
        return (
            "bytedance/seedance-2.5/reference-to-video",
            {
                "prompt": r2v_prompt(motion, "@Image1", "@Video1"),
                "image_urls": [jobs.upload(upid)],
                "video_urls": [ref],
                "resolution": "720p",
                "aspect_ratio": "1:1",
                "duration": "4",
                "generate_audio": False,
            },
            1.09 * 2.25,
        )
    if lane == "seedance25-r2v-720p":
        # Resolution probe on the winner candidate: token billing is
        # pixel-proportional, so 720p ≈ 2.25x the measured 480p actual.
        return (
            "bytedance/seedance-2.5/reference-to-video",
            {
                "prompt": r2v_prompt(motion, "@Image1", "@Video1"),
                "image_urls": [identity],
                "video_urls": [ref],
                "resolution": "720p",
                "aspect_ratio": "1:1",
                "duration": "4",
                "generate_audio": False,
            },
            1.09 * 2.25,
        )
    if lane == "seedance25-r2v":
        # The nominal token formula (h*w*(in+out)*24/1024, $0.0214/1000,
        # ×0.6 with video inputs ≈ $0.57) underbills ~2x: $1.09 measured
        # per 480p 4s take with a 2s input (運転知見 31).
        return (
            "bytedance/seedance-2.5/reference-to-video",
            {
                "prompt": r2v_prompt(motion, "@Image1", "@Video1"),
                "image_urls": [identity],
                "video_urls": [ref],
                "resolution": "480p",
                "aspect_ratio": "1:1",
                "duration": "4",
                "generate_audio": False,
            },
            1.09,
        )
    if lane == "kling-o3-r2v":
        # Kling requires element videos ≥ 3.0 s (422 measured on t2) and
        # bills output seconds only, so it gets the untrimmed 3-cycle ref.
        full_ref = jobs.upload(work / f"ref_{motion}.mp4")
        return (
            "fal-ai/kling-video/o3/pro/reference-to-video",
            {
                "prompt": r2v_prompt(motion, "@Element1", "@Element2"),
                # An element needs BOTH frontal_image_url and
                # reference_image_urls, or a video_url (422 measured on t1).
                "elements": [
                    {
                        "frontal_image_url": identity,
                        "reference_image_urls": [identity],
                    },
                    {"video_url": full_ref},
                ],
                "duration": "3",
                "aspect_ratio": "1:1",
                "generate_audio": False,
            },
            3 * 0.112,
        )
    if lane == "wan27-edit":
        return (
            "fal-ai/wan/v2.7/edit-video",
            {
                "prompt": EDIT_PROMPT.format(style=STYLE),
                "video_url": ref,
                "reference_image_url": identity,
                "resolution": "1080p",
            },
            # Output matches input; assume input seconds bill too (the r2v
            # sibling does — over-counting is the safe direction).
            2 * in_s * 0.10,
        )
    if lane == "scail2":
        return (
            "fal-ai/scail-2",
            {
                "prompt": SCAIL_PROMPT.format(
                    style=STYLE, motion=MOTION_TEXT[motion]
                ),
                "image_url": identity,
                "video_url": ref,
                "mode": "animation",
                "resolution": "704p",
            },
            in_s * 0.20,
        )
    if lane.startswith((
        "wanimate2-", "wanimate2g-", "wanimate2m-", "wanimate2p-", "wanimate2s-",
        "wanimate2r-",
    )):
        # 4b (fal-hosted Wan-Animate-2 — §7 残タスク 3 の 2026-08-18 更新):
        # one endpoint transfers the driving video's motion, camera and
        # framing onto the identity (no v1 move/replace split). The g
        # variant grounds the identity on chroma green: the 480p probe
        # measured a WHITE output background — the background authority is
        # the identity image, and the guidance-free distilled checkpoint
        # ignores the prompt's green statement (guidance_scale 1 = no CFG).
        family, resolution = lane.split("-", 1)
        if resolution not in WANIMATE2_EST:
            raise SystemExit(
                f"unknown wanimate2 resolution {resolution!r} — "
                f"expected one of {sorted(WANIMATE2_EST)}"
            )
        if motion == "carry":
            # The 4b carry driving is the CURRENT ledger canonical (the
            # head-raised re-render 155a7af8… behind the adopted carry
            # master), not 4a's pre-correction f090cc… trim.
            ref = jobs.upload(work / manifest["headupRef"]["trim"])
        if family in ("wanimate2p", "wanimate2s"):
            # Mold-surgery drivings (owner orders 2026-08-19), carry only.
            # p = palm-up wrists (LeftHand/RightHand X:-90 — REJECTED by the
            # owner: thumb loss + unnatural wrist bend). s = mitten hands
            # (both hand bones scaled 0.65 — orientation-less stubs, the
            # owner-chosen route). Both are bpy_pose_offset compositions on
            # the head-up motion GLB, cycle re-rendered and tiled ×2; the
            # driving is the ONLY change.
            if motion != "carry":
                raise SystemExit(f"{family} is a carry-only lane")
            name = {
                "wanimate2p": "ref_carry_palmup_2cycles.mp4",
                "wanimate2s": "ref_carry_mitten_2cycles.mp4",
            }[family]
            surgery = work / name
            if not surgery.exists():
                raise SystemExit(
                    f"{surgery.name} missing — render it first "
                    "(bpy_pose_offset + bpy_render_loop s14/p24 + tile x2)"
                )
            ref = jobs.upload(surgery)
        est_scale = 1.0
        if family == "wanimate2r":
            # Registration-take lane (§7 残タスク 1 のブロッカー 1): the
            # ADOPTED 4b recipes rerun with a THREE-cycle driving so
            # replace_lane register's "2 loops + TRIM_MIN_MARGIN" window
            # fits — walk = the ledger walk reference UNTRIMMED (75f =
            # 3×25), carry = the CURRENT ledger walk-carry reference (the
            # official mitten-mold re-render, 72f = 3×24). Recipe and
            # identity stay the adopted ones; only the driving length
            # changes, so compute-second billing scales by frames.
            ref_path = (
                work / "ref_walk.mp4" if motion == "walk"
                else ledger_carry_reference(work)
            )
            ref = jobs.upload(ref_path)
            est_scale = probe(ref_path).frames / 50
        identity_path = {
            "wanimate2": upscaled_identity,
            "wanimate2g": green_identity,
            "wanimate2m": matched_identity,
            "wanimate2p": matched_identity,
            "wanimate2s": matched_identity,
            "wanimate2r": matched_identity,
        }[family](work)
        payload = {
            "prompt": WANIMATE2_PROMPT,
            "video_url": ref,
            "image_url": jobs.upload(identity_path),
            "resolution": resolution,
            "aspect_ratio": "1:1",
            "frames_per_second": REF_FPS,
        }
        if seed is not None:
            payload["seed"] = seed
        est = WANIMATE2_EST[resolution] * est_scale
        if steps is not None:
            payload["num_inference_steps"] = steps
            est *= steps / 10  # compute-second billing scales with steps
        if mitten:
            if not guidance or guidance <= 1:
                raise SystemExit(
                    "--mitten needs --guidance > 1 — the CFG-free default "
                    "provably ignores prompts (4b probe)"
                )
            payload["prompt"] += MITTEN_PROMPT
            payload["negative_prompt"] = MITTEN_NEGATIVE
        if guidance is not None:
            payload["guidance_scale"] = guidance
            est *= 1.8  # CFG re-enables the unconditional pass (×1.77 measured)
        return ("fal-ai/wan-animate-2", payload, est)
    if lane in ("scail2-pose", "scail2-replace"):
        # §7 残タスク 3 のオプション追試: 4a の既定設定 (end_to_end ×
        # animation × 704p) はノイズ崩壊 — pose 駆動と replacement を
        # 512p で 1 本ずつだけ再試する ($0.20/出力秒・出力 16fps)。
        payload = {
            "prompt": SCAIL_PROMPT.format(style=STYLE, motion=MOTION_TEXT[motion]),
            "image_url": jobs.upload(upscaled_identity(work)),
            "video_url": ref,
            "resolution": "512p",
        }
        if lane == "scail2-pose":
            payload["driving_type"] = "pose"
        else:
            payload["mode"] = "replacement"
        return ("fal-ai/scail-2", payload, in_s * 0.20)
    raise SystemExit(f"unknown lane {lane!r}")


def upscaled_identity(work: Path) -> Path:
    """The adopted masters' identity input, fetched by content address."""
    path = work / "identity_upscaled_square.png"
    if not path.exists():
        path.write_bytes(get_object(UPSCALED_IDENTITY_SHA256))
    with Image.open(path) as img:
        if img.height < IDENTITY_MIN_HEIGHT:
            raise SystemExit(
                f"upscaled identity is {img.height}px tall — not the 4x input"
            )
    return path


def green_identity(work: Path) -> Path:
    """The upscaled identity re-grounded on chroma green (#00FF00). Border
    flood fill only, so every character pixel stays byte-identical to the
    adopted masters' identity input — only the background conditioning
    changes."""
    path = work / "identity_upscaled_green.png"
    if not path.exists():
        from PIL import ImageDraw

        img = Image.open(upscaled_identity(work)).convert("RGB")
        corners = (
            (0, 0), (img.width - 1, 0),
            (0, img.height - 1), (img.width - 1, img.height - 1),
        )
        for seed in corners:
            ImageDraw.floodfill(img, seed, (0, 255, 0), thresh=40)
        img.save(path)
    return path


# The driving mannequin's measured frame fractions (ref_walk_2cycles frame 1:
# subject height 43% of the frame, top margin 7%). The output inherits the
# IDENTITY's framing (99.5% height measured on the full-bleed square), so the
# redrawn character never covers the mannequin's region and its erasure can
# ghost — the framing-matched identity puts the character exactly where the
# mannequin is.
MATCHED_HEIGHT_FRAC = 0.43
MATCHED_TOP_FRAC = 0.07


def matched_identity(work: Path) -> Path:
    """The green identity re-framed to the driving video's mannequin box.
    The character crop comes from the SeedVR2 4x image (green-backed, so a
    rectangle paste is seamless on the same #00FF00 canvas) and is scaled
    DOWN — the 4x detail is kept, never re-upscaled."""
    path = work / "identity_matched_green.png"
    if not path.exists():
        img = Image.open(green_identity(work)).convert("RGB")
        a = np.asarray(img).astype(int)
        subject = ~((a[:, :, 1] - np.maximum(a[:, :, 0], a[:, :, 2])) >= 40)
        ys, xs = np.where(subject)
        crop = img.crop((xs.min(), ys.min(), xs.max() + 1, ys.max() + 1))
        side = img.width
        target_h = round(side * MATCHED_HEIGHT_FRAC)
        scale = target_h / crop.height
        small = crop.resize((round(crop.width * scale), target_h), Image.LANCZOS)
        canvas = Image.new("RGB", (side, side), (0, 255, 0))
        canvas.paste(
            small,
            ((side - small.width) // 2, round(side * MATCHED_TOP_FRAC)),
        )
        canvas.save(path)
    return path


def ledger_carry_reference(work: Path) -> Path:
    """The CURRENT master_models.json boy/walk-carry green reference (the
    registration lane's carry driving — the mitten-mold official 72f
    re-render once 作業 1 has landed), fetched by content address."""
    ledger = json.loads(
        (Path(__file__).resolve().parent / "master_models.json").read_text()
    )
    sha = ledger["models"]["boy"]["motions"]["walk-carry"]["reference"]["sha256"]
    path = work / "ref_carry_ledger.mp4"
    if not (path.exists() and hashlib.sha256(path.read_bytes()).hexdigest() == sha):
        path.write_bytes(get_object(sha))
    return path


def subject_mask(frame: Image.Image) -> np.ndarray:
    """Non-green-dominant pixels of an RGB frame (the bench's green rule)."""
    a = np.asarray(frame.convert("RGB")).astype(int)
    return ~((a[:, :, 1] - np.maximum(a[:, :, 0], a[:, :, 2])) >= 40)


def cmd_cropreg(work: Path, args: argparse.Namespace) -> None:
    """Fixed-frame content-centered square crop of one take (blocker 2 —
    the gangnam/girl 496² precedent): loop_scan's silhouette_mask shrinks
    the WHOLE frame to 160px before IoU, so a subject at ~43% of the frame
    (the matched-identity framing) measures systematically low. One box —
    the union of every frame's subject bbox + margin, squared — crops every
    frame identically, so the loop geometry is untouched and only the
    measurement resolution changes."""
    src = work / f"{args.key}.mp4"
    if not src.exists():
        raise SystemExit(f"{src} missing — run that lane first")
    frame_paths = extract_frames(src, work / f"frames_{src.stem}")
    lo_x = lo_y = 10**9
    hi_x = hi_y = -(10**9)
    for path in frame_paths:
        with Image.open(path) as frame:
            ys, xs = np.where(subject_mask(frame))
        lo_x, lo_y = min(lo_x, int(xs.min())), min(lo_y, int(ys.min()))
        hi_x, hi_y = max(hi_x, int(xs.max())), max(hi_y, int(ys.max()))
    with Image.open(frame_paths[0]) as first:
        width, height = first.size
    lo_x, lo_y = max(0, lo_x - args.margin), max(0, lo_y - args.margin)
    hi_x, hi_y = min(width, hi_x + 1 + args.margin), min(height, hi_y + 1 + args.margin)
    # Square the box around its center (clamped), then snap to even h264 dims.
    side = max(hi_x - lo_x, hi_y - lo_y)
    side = min(side + side % 2, width, height)
    cx, cy = (lo_x + hi_x) // 2, (lo_y + hi_y) // 2
    x0 = min(max(0, cx - side // 2), width - side)
    y0 = min(max(0, cy - side // 2), height - side)
    crop_dir = work / f"crop_{src.stem}"
    crop_dir.mkdir(exist_ok=True)
    for index, path in enumerate(frame_paths):
        with Image.open(path) as frame:
            frame.convert("RGB").crop((x0, y0, x0 + side, y0 + side)).save(
                crop_dir / f"crop_{index:03d}.png"
            )
    out = work / f"{args.key}_crop.mp4"
    fps = probe(src).fps
    run_quiet([
        "ffmpeg", "-y", "-loglevel", "error", "-framerate", f"{fps:g}",
        "-i", str(crop_dir / "crop_%03d.png"),
        "-an", "-c:v", "libx264", "-crf", "12", "-pix_fmt", "yuv420p",
        str(out),
    ])
    print(f"wrote {out.name}: box ({x0},{y0}) {side}² of {width}x{height}, "
          f"{len(frame_paths)} frames @ {fps:g}fps")


# All-frame hand-zoom band (運転知見 35 ⑤ — retake inspection must read
# EVERY frame's hands, not a sampled few). The band is cut from each
# frame's own subject bbox so hand pixels stay in-band while the character
# bobs; the white-ghost check rides the same strip (ghosts sit near the
# subject, well inside the padded band).
HAND_BAND = (0.35, 0.80)
HANDSTRIP_COLS = 8


def cmd_handstrip(work: Path, args: argparse.Namespace) -> None:
    from PIL import ImageDraw, ImageFont

    src = work / f"{args.key}.mp4"
    if not src.exists():
        raise SystemExit(f"{src} missing — run that lane first")
    frame_paths = extract_frames(src, work / f"frames_{src.stem}")
    font = ImageFont.truetype(JUDGMENT_FONT, 22)
    cells = []
    for index, path in enumerate(frame_paths):
        frame = Image.open(path).convert("RGB")
        ys, xs = np.where(subject_mask(frame))
        top, bottom = int(ys.min()), int(ys.max()) + 1
        left, right = int(xs.min()), int(xs.max()) + 1
        band_top = top + round((bottom - top) * HAND_BAND[0])
        band_bottom = top + round((bottom - top) * HAND_BAND[1])
        pad = 12
        band = frame.crop((
            max(0, left - pad), max(0, band_top),
            min(frame.width, right + pad), min(frame.height, band_bottom),
        ))
        band = band.resize((band.width * 2, band.height * 2), Image.NEAREST)
        cell = Image.new("RGB", (band.width, band.height + 28), (250, 250, 252))
        cell.paste(band, (0, 28))
        ImageDraw.Draw(cell).text((4, 2), f"f{index:02d}", font=font, fill=(0, 0, 0))
        cells.append(cell.convert("RGBA"))
    rows = [
        cells[i : i + HANDSTRIP_COLS]
        for i in range(0, len(cells), HANDSTRIP_COLS)
    ]
    out = work / f"hands_all_{src.stem}.png"
    montage_rows(rows, out)
    print(f"wrote {out.name} ({len(cells)} frames)")


def guarded_run(
    jobs: fal_client.FalJobs, key: str, model: str, payload: dict, est: float
) -> dict:
    """FalJobs.run behind the live-balance floor. Only a FRESH submission is
    guarded: a record without a result is an already-paid job being re-polled,
    and blocking that would strand the money already spent."""
    record = jobs.state.get("runs", {}).get(key)
    if record is None:
        remaining = balance()
        if remaining - est < BALANCE_FLOOR:
            raise SystemExit(
                f"balance stop: ${remaining:.2f} - est ${est:.2f} would fall "
                f"under the ${BALANCE_FLOOR:.2f} floor — not submitting {key}"
            )
    return jobs.run(key, model, payload, est)


def record_billing(work: Path, key: str, before: float, after: float) -> None:
    """Per-submission balance-delta bookkeeping. The fal balance API is the
    only true cost reading (BYOK gateway logs report cost=0 — 運転知見 31),
    and 4b's unit price starts unknown, so every fresh run writes its delta.
    Charges can post late (the edit-video precedent), so a delta is an
    attribution, not an invoice — the run report says so where it matters."""
    path = work / "billing.json"
    billing = json.loads(path.read_text()) if path.exists() else {}
    billing[key] = {
        "balanceBefore": round(before, 4),
        "balanceAfter": round(after, 4),
        "delta": round(before - after, 4),
    }
    path.write_text(json.dumps(billing, indent=1) + "\n")


def cmd_run(work: Path, args: argparse.Namespace) -> None:
    manifest = load_manifest(work)
    jobs = fal_client.FalJobs(work, args.budget)
    key = f"{args.lane}_{args.motion}_t{args.take}"
    if (
        args.steps or args.guidance or args.mitten or args.seed
    ) and not args.lane.startswith("wanimate2"):
        raise SystemExit(
            "--steps/--guidance/--mitten/--seed are wan-animate-2 knobs only"
        )
    model, payload, est = lane_request(
        args.lane, args.motion, manifest, jobs, work,
        steps=args.steps, guidance=args.guidance, mitten=args.mitten,
        seed=args.seed,
    )
    print(f"[{key}] {model} est ${est:.3f}")
    fresh = key not in jobs.state.get("runs", {})
    before = balance() if fresh else None
    t0 = time.time()
    result = guarded_run(jobs, key, model, payload, est)
    jobs.download(key, result["video"]["url"], dest=work / f"{key}.mp4")
    after = balance()
    if fresh:
        record_billing(work, key, before, after)
    print(f"[{key}] done in {time.time() - t0:.0f}s wall — "
          f"spent est ${jobs.state['spent_estimated']:.2f}/{args.budget:.2f}, "
          f"balance ${after:.2f}")


def cmd_settle(work: Path, key: str) -> None:
    """Re-read the balance into one billing entry. wan-animate-2 charges
    post ~2 minutes AFTER completion (measured on the 480p probe), so the
    at-completion delta reads 0 — run this once the charge lands, before
    the next submission (runs are serial, so the whole delta is the key's)."""
    path = work / "billing.json"
    billing = json.loads(path.read_text())
    entry = billing[key]
    entry["balanceAfter"] = round(balance(), 4)
    entry["delta"] = round(entry["balanceBefore"] - entry["balanceAfter"], 4)
    path.write_text(json.dumps(billing, indent=1) + "\n")
    print(f"[{key}] settled: {json.dumps(entry)}")


def cmd_upscale_identity(work: Path, args: argparse.Namespace) -> None:
    """SeedVR2 IMAGE 4x on the squared identity — the adopted walk master's
    identity preprocessing (運転知見 33: 右 3/4 のまま高解像度化)."""
    source = work / "identity_square.png"
    if not source.exists():
        raise SystemExit("identity_square.png missing — run `prepare` first")
    jobs = fal_client.FalJobs(work, args.budget)
    with Image.open(source) as img:
        est = img.width * img.height * args.factor**2 / 1e6 * 0.001
    result = guarded_run(
        jobs, f"upid_upscale_x{args.factor}", "fal-ai/seedvr/upscale/image",
        {
            "image_url": jobs.upload(source),
            "upscale_mode": "factor",
            "upscale_factor": args.factor,
        },
        max(est, 0.01),
    )
    import requests as _requests

    response = _requests.get(result["image"]["url"], timeout=300)
    response.raise_for_status()
    dest = work / "identity_upscaled_square.png"
    dest.write_bytes(response.content)
    with Image.open(dest) as up:
        print(f"wrote {dest} ({up.size[0]}x{up.size[1]})")


def cmd_seedvr(work: Path, args: argparse.Namespace) -> None:
    # <lane>:<motion>[:take] — run outputs are named <lane>_<motion>_t<N>,
    # so an omitted take defaults to t1 and a bare number gets the t prefix.
    parts = args.source.split(":")
    if len(parts) == 2:
        parts.append("t1")
    if not parts[-1].startswith("t"):
        parts[-1] = f"t{parts[-1]}"
    stem = "_".join(parts)
    source = work / f"{stem}.mp4"
    if not source.exists():
        raise SystemExit(f"{source} missing — run that lane first")
    info = probe(source)
    with Image.open(extract_frames(source, work / "seedvr_probe")[0]) as first:
        width, height = first.size
    est = width * height * info.frames * args.factor**2 / 1e6 * 0.001
    jobs = fal_client.FalJobs(work, args.budget)
    key = f"seedvr_{stem}_x{args.factor}"
    payload = {
        "video_url": jobs.upload(source),
        "upscale_mode": "factor",
        "upscale_factor": args.factor,
    }
    print(f"[{key}] fal-ai/seedvr/upscale/video est ${est:.3f}")
    result = guarded_run(jobs, key, "fal-ai/seedvr/upscale/video", payload, est)
    jobs.download(key, result["video"]["url"], dest=work / f"{key}.mp4")
    print(f"[{key}] done — balance ${balance():.2f}")


# ---------------------------------------------------------------- analyze


def green_border_fraction(frame_paths: list[Path]) -> tuple[float, float]:
    """Chroma-key aptitude over 3 samples: (min green-dominant share of the
    top/left/right borders, max subject share of the bottom row). The bottom
    row is scored separately because a bottom-aligned identity (the squarify
    precedent) makes wan-animate-2 frame the character with its feet ON the
    frame edge — that lowers a whole-border score (0.84-0.89 measured on the
    4b walk takes) without any chroma failure, the background itself being
    uniformly green."""
    fractions, contacts = [], []
    for path in (frame_paths[0], frame_paths[len(frame_paths) // 2], frame_paths[-1]):
        a = np.asarray(Image.open(path).convert("RGB")).astype(int)
        border = np.concatenate([a[0], a[:, 0], a[:, -1]])
        green = (border[:, 1] - np.maximum(border[:, 0], border[:, 2])) >= 40
        fractions.append(float(green.mean()))
        bottom = a[-1]
        bottom_green = (bottom[:, 1] - np.maximum(bottom[:, 0], bottom[:, 2])) >= 40
        contacts.append(1.0 - float(bottom_green.mean()))
    return min(fractions), max(contacts)


def measure_loop(masks: list[np.ndarray], expected: int) -> dict | None:
    """Best loop near the expected output-frame period (r2v lanes are not
    frame-synced, so the period is searched, not assumed)."""
    lo = max(8, round(expected * 0.6))
    hi = min(round(expected * 1.5), (len(masks) - 1) // 2)
    if hi < lo:
        if len(masks) >= 2 * expected:  # exactly-two-cycles window
            score = mask_iou(masks[0], masks[expected])
            return {"start": 0, "period": expected, "loopMean": None,
                    "closure": round(score, 3)}
        return None
    best: tuple[float, int, int] | None = None
    for period in range(lo, hi + 1):
        start, score = best_loop_start(masks, period)
        if best is None or score > best[0]:
            best = (score, period, start)
    score, period, start = best
    return {
        "start": start,
        "period": period,
        "loopMean": round(score, 3),
        "closure": round(mask_iou(masks[start], masks[start + period]), 3),
    }


def analyze_clip(path: Path, motion: str, work: Path) -> dict:
    info = probe(path)
    frame_paths = extract_frames(path, work / f"frames_{path.stem}")
    green, bottom_contact = green_border_fraction(frame_paths)
    entry: dict = {
        "file": path.name,
        "frames": info.frames,
        "fps": round(info.fps, 2),
        "seconds": round(info.duration, 2),
        "greenBorder": round(green, 3),
        "bottomContact": round(bottom_contact, 3),
    }
    ref_period_s = GREEN_REFS[motion]["period"] / REF_FPS
    entry["refCycleSeconds"] = round(ref_period_s, 3)
    if green >= 0.90:
        keyed_mid = chroma_key_greenwear(
            Image.open(frame_paths[len(frame_paths) // 2])
        )
        masks = [
            silhouette_mask(chroma_key_greenwear(Image.open(p)))
            for p in frame_paths
        ]
        loop = measure_loop(masks, round(ref_period_s * info.fps))
        if loop:
            loop["cycleSeconds"] = round(loop["period"] / info.fps, 3)
        entry["loop"] = loop
        # Identity fidelity is MEASURED against the actual identity cell's
        # palette (the walk lint's calibrated drift check), never asserted
        # from a hand-written description (運転知見 32).
        identity_cell = work / "identity_cell.png"
        if identity_cell.exists():
            entry["identityPaletteDrift"] = check_palette_drift(
                Image.open(identity_cell).convert("RGBA"),
                keyed_mid.crop(content_bbox(keyed_mid)),
            )
    return entry


def bench_outputs(work: Path) -> list[tuple[str, str, Path]]:
    """(lane, motion, path) for every downloaded bench output, v1 carry
    baseline included."""
    out = []
    for path in sorted(work.glob("*_t*.mp4")):
        # Derived material (loop_*.mp4) and the post-stage outputs also
        # match the take glob — only <lane>_<motion>_t<N> stems are lanes.
        if path.stem.startswith(("seedvr_", "loop_", "loops_")):
            continue
        lane, motion, take = path.stem.rsplit("_", 2)
        if motion not in GREEN_REFS:
            continue
        # Keep retakes distinct (t1 keeps the bare lane name so single-take
        # report keys and R2 slugs stay stable).
        if take != "t1":
            lane = f"{lane}:{take}"
        out.append((lane, motion, path))
    if (work / "v1_carry_720p.mp4").exists():
        out.append(("v1-replace", "carry", work / "v1_carry_720p.mp4"))
    for path in sorted(work.glob("seedvr_*.mp4")):
        motion = "walk" if "_walk" in path.stem else "carry"
        out.append(("seedvr:" + path.stem.removeprefix("seedvr_"), motion, path))
    return out


def cmd_analyze(work: Path) -> None:
    report: dict = {"balance": balance(), "lanes": {}}
    for lane, motion, path in bench_outputs(work):
        entry = analyze_clip(path, motion, work)
        report["lanes"].setdefault(motion, {})[lane] = entry
        print(f"{motion}/{lane}: {json.dumps(entry)}")
    (work / "bench-report.json").write_text(
        json.dumps(report, indent=1) + "\n"
    )


# --------------------------------------------------------------- material

# Judgment-sheet rendering (運転知見 34): every row carries its recipe and
# measured cost burned into the image, the ground-truth identity is row 1,
# and no text may be cut off — the header band wraps to as many lines as
# the caller's text needs at the sheet's width.
JUDGMENT_FONT = "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc"


def wrap_text(draw, text: str, font, max_width: int) -> list[str]:
    lines, current = [], ""
    for token in text.split(" "):
        candidate = f"{current} {token}".strip()
        if current and draw.textlength(candidate, font=font) > max_width:
            lines.append(current)
            current = token
        else:
            current = candidate
    if current:
        lines.append(current)
    return lines


def judgment_sheet(
    rows: list[tuple[str, str, list[Image.Image]]], out_path: Path,
    *, cell_height: int = 300,
) -> None:
    from PIL import ImageDraw, ImageFont

    font = ImageFont.truetype(JUDGMENT_FONT, 30)
    font_s = ImageFont.truetype(JUDGMENT_FONT, 23)
    pad = 16
    prepared = [
        (title, recipe, [scaled(c, cell_height / max(x.height for x in cells)) for c in cells])
        for title, recipe, cells in rows
    ]
    width = max(
        sum(c.width for c in cs) + pad * (len(cs) + 1) for _, _, cs in prepared
    )
    probe = ImageDraw.Draw(Image.new("RGB", (8, 8)))
    # Titles never wrap — widen the sheet to fit the longest one instead.
    width = max(width, max(
        int(probe.textlength(t, font=font)) + 2 * pad for t, _, _ in prepared
    ))
    banded = []
    for title, recipe, cells in prepared:
        lines = wrap_text(probe, recipe, font_s, width - 2 * pad) if recipe else []
        band_h = 44 + 30 * len(lines)
        banded.append((title, lines, band_h, cells))
    total_h = pad + sum(band_h + cell_height + pad for _, _, band_h, _ in banded)
    canvas = Image.new("RGB", (width, total_h), (250, 250, 252))
    draw = ImageDraw.Draw(canvas)
    y = pad
    for title, lines, band_h, cells in banded:
        draw.rectangle([0, y, width, y + band_h - 6], fill=(38, 44, 66))
        draw.text((pad, y + 4), title, font=font, fill=(255, 255, 255))
        for i, line in enumerate(lines):
            draw.text((pad, y + 42 + 30 * i), line, font=font_s, fill=(170, 200, 255))
        x = pad
        for c in cells:
            canvas.paste(c, (x, y + band_h + (cell_height - c.height)), c)
            x += c.width + pad
        y += band_h + cell_height + pad
    canvas.save(out_path)
    print(f"wrote {out_path}")



def phase_cells(path: Path, motion: str, work: Path, n: int = 8) -> list[Image.Image]:
    """n cells sampled over one measured (or expected) cycle, keyed when the
    clip is green, content-cropped either way."""
    info = probe(path)
    frame_paths = extract_frames(path, work / f"frames_{path.stem}")
    green = green_border_fraction(frame_paths)[0] >= 0.90
    expected = round(GREEN_REFS[motion]["period"] / REF_FPS * info.fps)
    start, period = 0, min(expected, len(frame_paths) - 1)
    if green:
        masks = [
            silhouette_mask(chroma_key_greenwear(Image.open(p)))
            for p in frame_paths
        ]
        loop = measure_loop(masks, expected)
        if loop:
            start, period = loop["start"], loop["period"]
    cells = []
    for i in range(n):
        index = min(start + round(i * period / n), len(frame_paths) - 1)
        frame = Image.open(frame_paths[index]).convert("RGBA")
        if green:
            frame = chroma_key_greenwear(frame)
            frame = frame.crop(content_bbox(frame))
        cells.append(frame)
    return cells


def cmd_material(work: Path) -> None:
    for motion in ("walk", "carry"):
        rows, labels = [], []
        # Ground-truth first row: the ACTUAL identity cell, so every montage
        # carries the real appearance next to the outputs (運転知見 32 —
        # the identity verdict must never rest on a written description).
        identity_cell = work / "identity_cell.png"
        if identity_cell.exists():
            truth = Image.open(identity_cell).convert("RGBA")
            rows.append([scaled(truth, 320 / truth.height)])
            labels.append("identity")
        ref = work / f"ref_{motion}_2cycles.mp4"
        entries = [("green-ref", ref)] + [
            (lane, path) for lane, m, path in bench_outputs(work) if m == motion
        ]
        for lane, path in entries:
            if not path.exists():
                continue
            cells = phase_cells(path, motion, work)
            height = max(c.height for c in cells)
            rows.append([scaled(c, 320 / height) for c in cells])
            labels.append(lane)
            game = preview_cells(cells, height=GAME_PREVIEW_HEIGHT)
            slug = lane.replace(":", "_")
            montage_rows([game], work / f"preview192_{motion}_{slug}.png")
            loop_video(cells, work / f"loop_{motion}_{slug}.mp4")
        if rows:
            montage_rows(rows, work / f"montage_{motion}.png")
            (work / f"montage_{motion}.txt").write_text("\n".join(labels) + "\n")
            print(f"montage_{motion}.png rows: {labels}")
        videos = [work / f"loop_{motion}_{l.replace(':', '_')}.mp4" for l in labels]
        stack_loop_videos(videos, labels, work / f"loops_side_by_side_{motion}.mp4")


def measured_cost(work: Path, key: str) -> str:
    path = work / "billing.json"
    if path.exists():
        entry = json.loads(path.read_text()).get(key)
        if entry:
            return (f"実測 ${entry['delta']:.2f} (残高 "
                    f"{entry['balanceBefore']:.2f}→{entry['balanceAfter']:.2f})")
    return "実測費用の記録なし"


def lane_desc(lane: str) -> str:
    base = lane.split(":")[0]
    if base.startswith("wanimate2-"):
        return (f"fal-ai/wan-animate-2 {base.removeprefix('wanimate2-')}・"
                "fps24・蒸留既定 (steps10/CFG1)・identity 白地")
    if base.startswith("wanimate2g-"):
        return (f"fal-ai/wan-animate-2 {base.removeprefix('wanimate2g-')}・"
                "fps24・蒸留既定 (steps10/CFG1)・identity 緑地")
    if base.startswith("wanimate2m-"):
        return (f"fal-ai/wan-animate-2 {base.removeprefix('wanimate2m-')}・"
                "fps24・蒸留既定 (steps10/CFG1)・identity 緑地+駆動枠一致 "
                "(高 43%/上 7%)")
    if base.startswith("wanimate2p-"):
        return (f"fal-ai/wan-animate-2 {base.removeprefix('wanimate2p-')}・"
                "fps24・identity 緑地+駆動枠一致・駆動 = 掌上向き手首手術版 "
                "(両手 X:-90)")
    if base.startswith("wanimate2s-"):
        return (f"fal-ai/wan-animate-2 {base.removeprefix('wanimate2s-')}・"
                "fps24・identity 緑地+駆動枠一致・駆動 = ミトン金型版 "
                "(両手ボーン 0.65 縮小)")
    if base.startswith("wanimate2r-"):
        return (f"fal-ai/wan-animate-2 {base.removeprefix('wanimate2r-')}・"
                "fps24・identity 緑地+駆動枠一致・駆動 = 3 周期 (登録用)")
    if base == "scail2-pose":
        return "fal-ai/scail-2 512p・pose 駆動・animation"
    if base == "scail2-replace":
        return "fal-ai/scail-2 512p・replacement"
    return base


def billing_key(lane: str, motion: str) -> str:
    if ":" in lane:
        base, take = lane.split(":")
        return f"{base}_{motion}_{take}"
    return f"{lane}_{motion}_t1"


def input_names(work: Path, state: dict) -> dict[str, str]:
    """CDN url -> local input filename, resolved through the upload cache
    (uploads map sha256 -> url; the local inputs are hashed once)."""
    sha_to_name = {}
    for path in list(work.glob("ref_*.mp4")) + list(work.glob("identity_*.png")):
        sha_to_name[hashlib.sha256(path.read_bytes()).hexdigest()] = path.name
    return {
        url: sha_to_name[sha]
        for sha, url in state.get("uploads", {}).items()
        if sha in sha_to_name
    }


def take_recipe(state: dict, names: dict, lane: str, motion: str) -> str | None:
    """The recipe actually PAID FOR, read back from the submitted payload.
    Burned-in labels must never trust a lane's defaults (Bugbot, PR #125:
    a --steps take was labeled steps10/CFG1, and the mold-surgery lanes
    were labeled with the canonical driving clip instead of their own) —
    every knob and input on the sheet comes from the run record."""
    record = state.get("runs", {}).get(billing_key(lane, motion))
    if not record or record.get("model") != "fal-ai/wan-animate-2":
        return None
    payload = record.get("payload", {})
    knobs = (
        f"steps{payload.get('num_inference_steps', 10)}"
        f"/CFG{payload.get('guidance_scale', 1):g}"
    )
    if "seed" in payload:
        knobs += f"・seed {payload['seed']}"
    if MITTEN_PROMPT.strip() in payload.get("prompt", ""):
        knobs += "・ミトンプロンプト"
    return (
        f"fal-ai/wan-animate-2 {payload.get('resolution')}・"
        f"fps{payload.get('frames_per_second', 24)}・{knobs}・"
        f"駆動 = {names.get(payload.get('video_url'), '?')}・"
        f"identity = {names.get(payload.get('image_url'), '?')}"
    )


REF_DESC = {
    "walk": "台帳 boy walk 緑参照 68f5542a… の 2 周期トリム (50f/24fps)",
    "carry": "台帳 boy walk-carry 頭起こし補正版 155a7af8… の 2 周期トリム "
    "(48f/24fps)",
}
V1_ROWS = {
    "walk": ("wan-2.2 animate/replace 720p・4a′ テイクの R2 再利用 "
             "(b267d7…)・実測 $0.25 (2026-08-15)"),
    "carry": ("v1 recast 720p の R2 再利用 (fb6d4e…・$0 — 4a′ 判定で"
              "服崩壊+手元の緑黄斑の不合格級)"),
}


def cmd_judgment(work: Path) -> None:
    """運転知見 34 judgment sheets + adopted-master parallel loops: every
    row carries model / resolution / inputs / measured cost burned into the
    image, ground truth (the actual identity) is row 1, and the side-by-side
    loop video puts the adopted master next to every challenger."""
    state_path = work / "state.json"
    state = json.loads(state_path.read_text()) if state_path.exists() else {}
    names = input_names(work, state)
    for motion in ("walk", "carry"):
        challengers = [
            (lane, path) for lane, m, path in bench_outputs(work)
            if m == motion and lane != "v1-replace"
        ]
        if not challengers:
            continue
        rows: list[tuple[str, str, list[Image.Image]]] = []
        truth = Image.open(work / "identity_cell.png").convert("RGBA")
        upid = Image.open(upscaled_identity(work)).convert("RGBA")
        rows.append((
            "1. 元画像 (正解) identity",
            "左 = R2 原本 stand セル (クロマキー済)・右 = SeedVR2 4x 入力 "
            "1600² (c7b3f904… — 採用マスターと同一 identity)",
            [truth, upid],
        ))
        ref_path = work / (
            "ref_carry_headup_2cycles.mp4" if motion == "carry"
            else "ref_walk_2cycles.mp4"
        )
        rows.append((
            f"2. 駆動動画 (3D 緑参照・{motion})", REF_DESC[motion],
            phase_cells(ref_path, motion, work),
        ))
        master_path = work / f"master_{motion}.mp4"
        if not master_path.exists():
            master_path.write_bytes(get_object(ADOPTED_MASTERS[motion]["sha256"]))
        master_cells = phase_cells(master_path, motion, work)
        rows.append((
            "3. 採用マスター (比較基準・master_takes.json)",
            ADOPTED_MASTERS[motion]["recipe"], master_cells,
        ))
        v1_path = work / (
            "v1_carry_720p.mp4" if motion == "carry" else "v1_walk_720p.mp4"
        )
        if motion == "walk" and not v1_path.exists():
            v1_path.write_bytes(get_object(V1_WALK_TAKE))
        number = 4
        if v1_path.exists():
            rows.append((
                f"{number}. v1 replace (参考)", V1_ROWS[motion],
                phase_cells(v1_path, motion, work),
            ))
            number += 1
        loops = [(f"master-{motion}", master_cells)]
        for lane, path in challengers:
            cells = phase_cells(path, motion, work)
            actual = take_recipe(state, names, lane, motion)
            base = actual or (
                f"{lane_desc(lane)}・駆動 = {REF_DESC[motion]}・identity "
                "= SeedVR2 4x 立ちセル"
            )
            recipe = f"{base}・{measured_cost(work, billing_key(lane, motion))}"
            rows.append((f"{number}. {lane}", recipe, cells))
            number += 1
            loops.append((lane.replace(":", "-"), cells))
        out = work / f"judgment_{motion}.png"
        judgment_sheet(rows, out)
        video_paths, labels = [], []
        for label, cells in loops:
            # The loops_ prefix keeps these out of bench_outputs' take glob.
            loop_path = work / f"loops_judge_{motion}_{label}.mp4"
            loop_video(cells, loop_path)
            video_paths.append(loop_path)
            labels.append(label)
        stack_loop_videos(
            video_paths, labels, work / f"loops_vs_master_{motion}.mp4"
        )


# The 4b owner-approved TWO-cycle takes (最終裁定 2026-08-19 — §7「4b 実施
# 結果」)。登録用 3 周期再生成の比較基準行: 承認されたのはレシピと 2 周期版
# の絵なので、台帳書き込み前の並列材料はこの 2 本に対して組む。
APPROVED_TAKES = {
    "walk": {
        "sha256": "4f57e1405c1fed177a75fd931832edc086bd54d44e4f6bd0ee7ac83189d0d41a",
        "recipe": ("fal-ai/wan-animate-2 720p・steps20/CFG1・seed 1974552879・"
                   "50f/24fps・駆動 = 台帳 boy walk 緑参照 68f5542a… の 2 周期"
                   "トリム・実測 $0.253 (4b 2026-08-18)"),
    },
    "carry": {
        "sha256": "6b4838a9f1831c03a249678c8fa6f9697c5ad06c87c1aa80fab5b666cbf1e72f",
        "recipe": ("fal-ai/wan-animate-2 720p・steps30/CFG1・seed 124940612・"
                   "48f/24fps・駆動 = ミトン金型 2 周期緑参照 882dc2cc…・"
                   "実測 $0.37 (4b 2026-08-18 t2)"),
    },
}


def cmd_regjudgment(work: Path) -> None:
    """登録用再生成テイク (wanimate2r) vs 4b 承認テイクの並列判定材料
    (運転知見 34 形式)。承認テイクは R2 から内容アドレスで取得し、再生成側の
    recipe は支払済みペイロードから読み戻す (PR #126 の教訓)。"""
    state_path = work / "state.json"
    state = json.loads(state_path.read_text()) if state_path.exists() else {}
    names = input_names(work, state)
    for motion in ("walk", "carry"):
        regenerated = sorted(
            path for path in work.glob(f"wanimate2r-*_{motion}_t*.mp4")
            if not path.stem.endswith("_crop")
        )
        if not regenerated:
            continue
        truth = Image.open(work / "identity_cell.png").convert("RGBA")
        upid = Image.open(upscaled_identity(work)).convert("RGBA")
        rows: list[tuple[str, str, list[Image.Image]]] = [(
            "1. 元画像 (正解) identity",
            "左 = R2 原本 stand セル (クロマキー済)・右 = SeedVR2 4x 入力 "
            "1600² (採用レシピと同一 identity)",
            [truth, upid],
        )]
        approved_path = work / f"approved_{motion}.mp4"
        if not approved_path.exists():
            approved_path.write_bytes(get_object(APPROVED_TAKES[motion]["sha256"]))
        approved_cells = phase_cells(approved_path, motion, work)
        rows.append((
            "2. 4b 承認テイク (2 周期・比較基準)",
            APPROVED_TAKES[motion]["recipe"], approved_cells,
        ))
        loops = [(f"approved-{motion}", approved_cells)]
        number = 3
        for path in regenerated:
            lane, _, take = path.stem.rsplit("_", 2)
            lane_key = lane if take == "t1" else f"{lane}:{take}"
            cells = phase_cells(path, motion, work)
            actual = take_recipe(state, names, lane_key, motion)
            recipe = (f"{actual or lane_desc(lane_key)}・"
                      f"{measured_cost(work, billing_key(lane_key, motion))}")
            rows.append((f"{number}. 登録用再生成 {path.stem} (3 周期)",
                         recipe, cells))
            loops.append((path.stem, cells))
            number += 1
        judgment_sheet(rows, work / f"regjudgment_{motion}.png")
        video_paths, labels = [], []
        for label, cells in loops:
            # loops_ プレフィックスで bench_outputs のテイク glob から除外。
            loop_path = work / f"loops_reg_{motion}_{label}.mp4"
            loop_video(cells, loop_path)
            video_paths.append(loop_path)
            labels.append(label)
        stack_loop_videos(
            video_paths, labels, work / f"loops_reg_vs_approved_{motion}.mp4"
        )


def stack_loop_videos(videos: list[Path], labels: list[str], out: Path) -> None:
    existing = [(v, l) for v, l in zip(videos, labels) if v.exists()]
    if len(existing) < 2:
        return
    cmd = ["ffmpeg", "-y", "-loglevel", "error"]
    for video, _ in existing:
        cmd += ["-stream_loop", "-1", "-t", "6", "-i", str(video)]
    parts = [
        f"[{i}:v]scale=-2:420,drawtext=text='{label}':x=8:y=8:fontsize=22:"
        f"fontcolor=black:box=1:boxcolor=white@0.7[v{i}]"
        for i, (_, label) in enumerate(existing)
    ]
    chain = "".join(f"[v{i}]" for i in range(len(existing)))
    filtergraph = ";".join(parts) + f";{chain}hstack=inputs={len(existing)}[out]"
    cmd += ["-filter_complex", filtergraph, "-map", "[out]",
            "-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p", str(out)]
    run_quiet(cmd)
    print(f"wrote {out.name}")


# ----------------------------------------------------------------- upload


def cmd_upload(work: Path) -> None:
    hashes = {}
    for lane, motion, path in bench_outputs(work):
        if lane == "v1-replace" and motion == "carry":
            hashes[f"{motion}/{lane}"] = V1_CARRY_TAKE  # already in R2
            continue
        hashes[f"{motion}/{lane}"] = put_object(path.read_bytes())
        print(f"{motion}/{lane}: {hashes[f'{motion}/{lane}']}")
    (work / "r2-hashes.json").write_text(json.dumps(hashes, indent=1) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("workdir", type=Path)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("prepare")
    run = sub.add_parser("run")
    run.add_argument("--lane", required=True)
    run.add_argument("--motion", required=True, choices=["walk", "carry"])
    run.add_argument("--take", type=int, default=1)
    run.add_argument("--budget", type=float, default=4.0)
    run.add_argument("--steps", type=int)
    run.add_argument("--guidance", type=float)
    run.add_argument("--mitten", action="store_true")
    run.add_argument("--seed", type=int)
    seedvr = sub.add_parser("seedvr")
    seedvr.add_argument("--source", required=True, help="<lane>:<motion>[:tN]")
    seedvr.add_argument("--factor", type=int, default=2)
    seedvr.add_argument("--budget", type=float, default=4.0)
    upscale = sub.add_parser("upscale-identity")
    upscale.add_argument("--factor", type=int, default=4)
    upscale.add_argument("--budget", type=float, default=4.0)
    settle = sub.add_parser("settle")
    settle.add_argument("--key", required=True)
    sub.add_parser("analyze")
    sub.add_parser("material")
    sub.add_parser("judgment")
    sub.add_parser("upload")
    cropreg = sub.add_parser("cropreg")
    cropreg.add_argument("--key", required=True, help="take key, e.g. wanimate2r-720p_walk_t1")
    cropreg.add_argument("--margin", type=int, default=16)
    handstrip = sub.add_parser("handstrip")
    handstrip.add_argument("--key", required=True)
    sub.add_parser("regjudgment")
    costs = sub.add_parser("costs")
    costs.add_argument("--limit", type=int, default=30)

    args = parser.parse_args()
    args.workdir.mkdir(parents=True, exist_ok=True)
    if args.command == "prepare":
        cmd_prepare(args.workdir)
    elif args.command == "run":
        cmd_run(args.workdir, args)
    elif args.command == "seedvr":
        cmd_seedvr(args.workdir, args)
    elif args.command == "upscale-identity":
        cmd_upscale_identity(args.workdir, args)
    elif args.command == "settle":
        cmd_settle(args.workdir, args.key)
    elif args.command == "analyze":
        cmd_analyze(args.workdir)
    elif args.command == "material":
        cmd_material(args.workdir)
    elif args.command == "judgment":
        cmd_judgment(args.workdir)
    elif args.command == "cropreg":
        cmd_cropreg(args.workdir, args)
    elif args.command == "handstrip":
        cmd_handstrip(args.workdir, args)
    elif args.command == "regjudgment":
        cmd_regjudgment(args.workdir)
    elif args.command == "upload":
        cmd_upload(args.workdir)
    elif args.command == "costs":
        fal_client.print_costs(args.limit)


if __name__ == "__main__":
    main()
