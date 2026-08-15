#!/usr/bin/env python3
"""Factory v2 step 4a spike: fal-hosted r2v-generation bench (docs/
factory-v2-plan.md §7 結論 3 — the layer-2 shootout's zero-setup bracket).

Baseline = the current v1 lane (wan-2.2 animate/replace 720p, the recast
form: 3D green reference × the committed boy stand cell). Challengers = the
r2v generation hosted on fal (wan 2.7 r2v 1080p / MiniMax H3 r2v 768p /
seedance 2.5 r2v / Kling o3 pro r2v), plus two contrast paradigms:
wan 2.7 edit-video (repaint the green reference into the kaede style
instead of transplanting an identity) and fal-ai/scail-2 (the 4b target
that turned out to be fal-hosted at bench time — recorded in the run
report). SeedVR2 video upscaling rides as an independent post-stage lever
on promising outputs.

Every lane gets the SAME inputs: the ledger's green reference
(master_models.json boy walk 68f554… / walk-carry f090cc…) trimmed to two
bone-verified cycles (wan 2.7 r2v and seedance bill input video seconds),
and the committed boy stand cell squared on white (the replace-lane
squarify precedent) as the identity image. Money mechanics ride
fal_client.FalJobs unchanged (state-persisted keys — re-runs never
re-spend, --budget stop) plus a live fal-balance floor check before every
submission: the account balance at bench start was $4.31, so the declared
~$10 cap is theoretical and the balance API is the real limiter.

Analysis is comparative, not gating (the bench verdict is the owner's):
chroma-key aptitude (green-border fraction), loop closure and measured
period vs the reference's cycle seconds (period inheritance — r2v models
are NOT frame-synced, unlike replace), and PR #98-style verdict material
(per-model phase montage, game-scale 192px previews, side-by-side loop
video, measured cost/time table).

Usage:
    export CLOUDFLARE_API_TOKEN=...
    python3 scripts/factory/spike_r2v_bench.py <workdir> prepare
    python3 scripts/factory/spike_r2v_bench.py <workdir> run \
        --lane wan27-r2v --motion walk [--take 1] [--budget 4.0]
    python3 scripts/factory/spike_r2v_bench.py <workdir> seedvr \
        --source <lane>:<motion>[:take] [--factor 2] [--budget 4.0]
    python3 scripts/factory/spike_r2v_bench.py <workdir> analyze
    python3 scripts/factory/spike_r2v_bench.py <workdir> material
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
IDENTITY_SOURCE = (
    ROOT / "packages/client/src/game.package/avatar/stand.png"
)
REF_FPS = 24
# Keep at least this much fal balance unspent — a lane that would dip below
# it stops the bench instead of stranding a half-billed queue job.
BALANCE_FLOOR = 0.20
GAME_PREVIEW_HEIGHT = 192

STYLE = (
    "a cute chibi anime boy with neat brown hair, big eyes, a white t-shirt, "
    "blue-gray shorts and sneakers, soft anime style with clean outlines "
    "(exactly the character in the reference image)"
)
MOTION_TEXT = {
    "walk": "walking in place with strictly alternating legs and "
    "opposite-phase arm swing",
    "carry": "walking in place holding both hands still in front of the "
    "belly as if carrying something, legs strictly alternating",
}


def r2v_prompt(motion: str, image_ref: str, video_ref: str) -> str:
    return (
        f"{image_ref} is the character: {STYLE}. {video_ref} is the motion "
        f"reference: an untextured 3D mannequin {MOTION_TEXT[motion]}. "
        f"Recreate the video with the character from {image_ref} performing "
        "EXACTLY the same motion, pose timing and cycle rhythm as "
        f"{video_ref}. Full body always visible, the character stays "
        "centered and does not travel across the frame. Flat pure green "
        "#00FF00 chroma-key background, no shadows, no ground line, no "
        "props, static camera, no cuts, no camera motion."
    )


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

    # Identity: committed boy stand cell, white-composited and squared (the
    # replace lane's squarify precedent), nearest-upscaled 4x so tiny-canvas
    # rejections cannot skew the bench (no information is added).
    cell = Image.open(IDENTITY_SOURCE).convert("RGBA")
    side = max(cell.size)
    canvas = Image.new("RGBA", (side, side), (255, 255, 255, 255))
    canvas.paste(cell, ((side - cell.width) // 2, side - cell.height), cell)
    identity = canvas.convert("RGB").resize(
        (side * 4, side * 4), Image.NEAREST
    )
    identity_path = work / "identity_square.png"
    identity.save(identity_path)
    manifest["identity"] = {"file": identity_path.name, "size": identity.size}
    manifest_path(work).write_text(json.dumps(manifest, indent=1) + "\n")
    print(f"prepared inputs — identity {identity.size}, balance ${balance():.2f}")


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
            5 * 0.08,
        )
    if lane == "seedance25-r2v":
        # Token-priced: h*w*(in+out)*24/1024 tokens, $0.0214/1000, ×0.6 with
        # video inputs. 560² overestimates a 480p square output (~35% pad).
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
            560 * 560 * (in_s + 4) * 24 / 1024 / 1000 * 0.0214 * 0.6,
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
    raise SystemExit(f"unknown lane {lane!r}")


def guarded_run(
    jobs: fal_client.FalJobs, key: str, model: str, payload: dict, est: float
) -> dict:
    """FalJobs.run behind the live-balance floor (skipped for cached keys)."""
    record = jobs.state.get("runs", {}).get(key)
    if record is None or "result" not in record:
        remaining = balance()
        if remaining - est < BALANCE_FLOOR:
            raise SystemExit(
                f"balance stop: ${remaining:.2f} - est ${est:.2f} would fall "
                f"under the ${BALANCE_FLOOR:.2f} floor — not submitting {key}"
            )
    return jobs.run(key, model, payload, est)


def cmd_run(work: Path, args: argparse.Namespace) -> None:
    manifest = load_manifest(work)
    jobs = fal_client.FalJobs(work, args.budget)
    key = f"{args.lane}_{args.motion}_t{args.take}"
    model, payload, est = lane_request(args.lane, args.motion, manifest, jobs, work)
    print(f"[{key}] {model} est ${est:.3f}")
    t0 = time.time()
    result = guarded_run(jobs, key, model, payload, est)
    jobs.download(key, result["video"]["url"], dest=work / f"{key}.mp4")
    print(f"[{key}] done in {time.time() - t0:.0f}s wall — "
          f"spent est ${jobs.state['spent_estimated']:.2f}/{args.budget:.2f}, "
          f"balance ${balance():.2f}")


def cmd_seedvr(work: Path, args: argparse.Namespace) -> None:
    source = work / f"{args.source.replace(':', '_')}.mp4"
    if not source.exists():
        raise SystemExit(f"{source} missing — run that lane first")
    info = probe(source)
    with Image.open(extract_frames(source, work / "seedvr_probe")[0]) as first:
        width, height = first.size
    est = width * height * info.frames * args.factor**2 / 1e6 * 0.001
    jobs = fal_client.FalJobs(work, args.budget)
    key = f"seedvr_{args.source.replace(':', '_')}_x{args.factor}"
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
        masks = [
            silhouette_mask(chroma_key_greenwear(Image.open(p)))
            for p in frame_paths
        ]
        loop = measure_loop(masks, round(ref_period_s * info.fps))
        if loop:
            loop["cycleSeconds"] = round(loop["period"] / info.fps, 3)
        entry["loop"] = loop
    return entry


def bench_outputs(work: Path) -> list[tuple[str, str, Path]]:
    """(lane, motion, path) for every downloaded bench output, v1 carry
    baseline included."""
    out = []
    for path in sorted(work.glob("*_t*.mp4")):
        lane, motion, _ = path.stem.rsplit("_", 2)
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
    sub.add_parser("analyze")
    sub.add_parser("material")
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
    elif args.command == "analyze":
        cmd_analyze(args.workdir)
    elif args.command == "material":
        cmd_material(args.workdir)
    elif args.command == "upload":
        cmd_upload(args.workdir)
    elif args.command == "costs":
        fal_client.print_costs(args.limit)


if __name__ == "__main__":
    main()
