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
# llms.txt pricing is UNSET ("$0 per compute seconds" — 2026-08-18), so the
# unit price is unknown until measured. These per-take guesses are
# deliberately conservative (over-counting is the safe direction for the
# budget/floor stops); the 480p probe's balance delta recalibrates them.
WANIMATE2_EST = {"480p": 0.75, "580p": 1.20, "720p": 1.80}

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
    lane: str, motion: str, manifest: dict, jobs: fal_client.FalJobs, work: Path
) -> tuple[str, dict, float]:
    """(model id, payload, estimated USD) for one lane × motion."""
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
    if lane.startswith("wanimate2-"):
        # 4b (fal-hosted Wan-Animate-2 — §7 残タスク 3 の 2026-08-18 更新):
        # one endpoint transfers the driving video's motion, camera and
        # framing onto the identity (no v1 move/replace split).
        resolution = lane.removeprefix("wanimate2-")
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
        return (
            "fal-ai/wan-animate-2",
            {
                "prompt": WANIMATE2_PROMPT,
                "video_url": ref,
                "image_url": jobs.upload(upscaled_identity(work)),
                "resolution": resolution,
                "aspect_ratio": "1:1",
                "frames_per_second": REF_FPS,
            },
            WANIMATE2_EST[resolution],
        )
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
    model, payload, est = lane_request(args.lane, args.motion, manifest, jobs, work)
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


def green_border_fraction(frame_paths: list[Path]) -> float:
    """Chroma-key aptitude: min green-dominant border share over 3 samples."""
    fractions = []
    for path in (frame_paths[0], frame_paths[len(frame_paths) // 2], frame_paths[-1]):
        a = np.asarray(Image.open(path).convert("RGB")).astype(int)
        border = np.concatenate([a[0], a[-1], a[:, 0], a[:, -1]])
        green = (border[:, 1] - np.maximum(border[:, 0], border[:, 2])) >= 40
        fractions.append(float(green.mean()))
    return min(fractions)


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
    green = green_border_fraction(frame_paths)
    entry: dict = {
        "file": path.name,
        "frames": info.frames,
        "fps": round(info.fps, 2),
        "seconds": round(info.duration, 2),
        "greenBorder": round(green, 3),
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
    green = green_border_fraction(frame_paths) >= 0.90
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
                "fps24・蒸留既定 (steps10/CFG1)")
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
            recipe = (f"{lane_desc(lane)}・駆動 = {REF_DESC[motion]}・identity "
                      f"= SeedVR2 4x 立ちセル・"
                      f"{measured_cost(work, billing_key(lane, motion))}")
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
    seedvr = sub.add_parser("seedvr")
    seedvr.add_argument("--source", required=True, help="<lane>:<motion>[:tN]")
    seedvr.add_argument("--factor", type=int, default=2)
    seedvr.add_argument("--budget", type=float, default=4.0)
    upscale = sub.add_parser("upscale-identity")
    upscale.add_argument("--factor", type=int, default=4)
    upscale.add_argument("--budget", type=float, default=4.0)
    sub.add_parser("analyze")
    sub.add_parser("material")
    sub.add_parser("judgment")
    sub.add_parser("upload")
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
    elif args.command == "analyze":
        cmd_analyze(args.workdir)
    elif args.command == "material":
        cmd_material(args.workdir)
    elif args.command == "judgment":
        cmd_judgment(args.workdir)
    elif args.command == "upload":
        cmd_upload(args.workdir)
    elif args.command == "costs":
        fal_client.print_costs(args.limit)


if __name__ == "__main__":
    main()
