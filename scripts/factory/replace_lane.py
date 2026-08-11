#!/usr/bin/env python3
"""fal replace production lane (Phase 5 ①c — the PR #101 spike promoted to
the factory; avatar-rig.md §6 DP-B の本採用).

Master-take method: one approved green-screen take per motion × silhouette
family is the MASTER (ledger: master_takes.json). A new character needs one
identity image and one wan-2.2 animate/replace call per motion — the
replace output inherits the master's choreography, timing and silhouette
frame (PR #101: a frame-mismatched master crushes hair volume, so the
ledger key includes the family).

The ledger's registration requirements (enforced by `register`):
1. green background (chroma-key contract — machine-checked on the frames)
2. owner approval (--approval provenance note, required)
3. machine-verified loop closure (loop_scan gates)
The canonical master is the ffmpeg-TRIMMED version (one loop + substitution
margin, ≤ 97 frames ≈ $0.24/replace at 480p): billing is output frames =
input frames ($0.04 per 16 frames at 480p), so a 5-second source is never
submitted as-is.

Recipe (owner-settled, PR #101): wan replace 480p, identity = A-pose padded
square with its background color, default 20 inference steps (the steps
knob is NOT exposed — owner rejected it), use_turbo only on takes that
need the quality boost (~3x slower, no extra cost). Blink frames are
generated on the new character's side, so cells are picked blink-aware
(blink.py) and a face strip ships with the verdict material.

Subcommands:
    register  trim + machine-gate + upload an approved take as a master
    produce   run one order (発注書 JSON) end to end: ledger lookup →
              replace → chroma key → loop verify → blink-aware cells →
              transparent sheet + neck anchors + verdict material
    costs     fal balance (the real spend meter) + recent gateway requests

Usage:
    export CLOUDFLARE_API_TOKEN=...
    python3 scripts/factory/replace_lane.py register \
        --motion gangnam --family boy --source <sha256|path> \
        --approval "PR #101 承認済み本番テイク" [--workdir DIR]
    python3 scripts/factory/replace_lane.py produce <order.json> \
        [--workdir DIR] [--budget 1.0]
    python3 scripts/factory/replace_lane.py costs [--limit 20]

Order (発注書) fields: id, motion, family, identity (R2 sha256 or path),
standSource (same — the sheet's reference cell), optional resolution
(default 480p), useTurbo, cells (default 8), posePrefix (default "dance").
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

from factory import fal_client  # noqa: E402
from factory.anchors import hair_reference, hair_stats  # noqa: E402
from factory.art_lint import check_gesture_cell  # noqa: E402
from factory.blink import eye_openness_score, select_cells  # noqa: E402
from factory.compose_sheet import chroma_key_greenwear, content_bbox  # noqa: E402
from factory.loop_scan import (  # noqa: E402
    CLOSURE_MIN,
    LOOP_MEAN_MIN,
    best_loop_start,
    find_loop,
    mask_iou,
    silhouette_mask,
    verify_loop,
)
from factory.verdict_material import (  # noqa: E402
    CELL_PAD,
    face_strip,
    loop_video,
    montage_rows,
    preview_cells,
    scaled,
)
from factory.video import extract_frames, probe, trim  # noqa: E402
from r2_originals import get_object, put_object, sha256_of  # noqa: E402

LEDGER_PATH = Path(__file__).resolve().parent / "master_takes.json"
SHA256_PATTERN = re.compile(r"[0-9a-f]{64}\Z")
# Order ids are lowercase dotted slugs (run_avatar's rule): the id names the
# order's workdir under --workdir, so a crafted id must not traverse out of
# it, and it must not shadow a register workdir (register-<motion>-<family>).
# Every file INSIDE the workdir is lane-named (the paid download included —
# see jobs.download's explicit dest), so ids cannot collide with them.
ORDER_ID_PATTERN = re.compile(r"[a-z0-9][a-z0-9.-]*\Z")
REGISTER_WORKDIR_PREFIX = "register-"

# One loop + substitution margin: 97 frames = 6.0625 billed video-seconds
# ($0.2425 at 480p). The window must hold ≥ 2 loop instances so every cell
# slot has a phase-equivalent substitute (blink.py), which caps the periods
# a master may have — slow cycles need a deliberate TRIM_MAX_FRAMES raise.
TRIM_MAX_FRAMES = 97
TRIM_MIN_MARGIN = 4

# Loop gates for replace OUTPUTS (masters use loop_scan's stricter gates):
# identity redraw noise costs a few points of IoU even on owner-accepted
# takes — healthy replace outputs measure loop-mean 0.910-0.961 / closure
# 0.949-0.985 (PR #101 takes + this lane's e2e, re-measured 2026-08-11 on
# loop_scan's metric with the green-wear-safe key), while the one known
# broken cycle scores 0.869 loop-mean. The visual gate (loop_96px.mp4)
# stays authoritative above these floors.
OUTPUT_LOOP_MEAN_MIN = 0.89
OUTPUT_CLOSURE_MIN = 0.92

# Sheet composition (the gesture lane's working scale).
STAND_WORK_HEIGHT = 400
STAND_HEIGHT_PX = 96
# Border pixels of a green-screen clip that must be green-dominant.
GREEN_BORDER_MIN = 0.95
BACKGROUND_KEY_DISTANCE = 40

DEFAULT_CELLS = 8
DEFAULT_RESOLUTION = "480p"


def fetch_r2(sha256: str, dest: Path) -> Path:
    """Content-addressed fetch into the workdir (get_object verifies)."""
    if dest.exists() and sha256_of(dest) == sha256:
        return dest
    dest.write_bytes(get_object(sha256))
    return dest


def resolve_input(value: str, work: Path, name: str) -> Path:
    """An order input: a 64-hex R2 content address or a local file path."""
    if SHA256_PATTERN.fullmatch(value):
        return fetch_r2(value, work / f"{name}.bin")
    path = Path(value)
    if not path.is_file():
        raise SystemExit(f"{name}: {value} is neither a sha256 nor a local file")
    return path


def border_pixels(a: np.ndarray) -> np.ndarray:
    """The image's outer 1px frame as an (n, channels) array."""
    return np.concatenate([a[0], a[-1], a[:, 0], a[:, -1]])


def assert_green_background(frames: list[Path]) -> None:
    """The clip is a green-screen take (the chroma-key contract). Checked on
    masters at registration and on every replace output: an off-green
    generation would key nothing, making every silhouette mask the full
    frame and the loop gate vacuously green-lit."""
    for path in (frames[0], frames[len(frames) // 2], frames[-1]):
        a = np.asarray(Image.open(path).convert("RGB")).astype(int)
        border = border_pixels(a)
        green = (border[:, 1] - np.maximum(border[:, 0], border[:, 2])) >= 40
        if green.mean() < GREEN_BORDER_MIN:
            raise SystemExit(
                f"{path.name}: only {green.mean():.0%} of the border is green "
                f"— not a green-screen clip (chroma-key contract)"
            )


def keyed_frames(paths: list[Path]) -> list[Image.Image]:
    return [chroma_key_greenwear(Image.open(p)) for p in paths]


def trim_cell(keyed: Image.Image) -> Image.Image:
    return keyed.crop(content_bbox(keyed))


# ---------------------------------------------------------------- register


def load_ledger() -> dict:
    if not LEDGER_PATH.exists():
        raise SystemExit(
            f"{LEDGER_PATH} is missing — the master-take ledger is committed "
            "with the factory; restore it before registering or producing"
        )
    return json.loads(LEDGER_PATH.read_text())


def cmd_register(args: argparse.Namespace) -> None:
    work = args.workdir / f"register-{args.motion}-{args.family}"
    work.mkdir(parents=True, exist_ok=True)
    if not args.approval.strip():
        raise SystemExit("--approval must record where the owner approved this take")
    ledger = load_ledger()
    source = resolve_input(args.source, work, "source")
    source_sha = sha256_of(source)

    frames = extract_frames(source, work / "frames_source")
    assert_green_background(frames)
    masks = [silhouette_mask(img) for img in keyed_frames(frames)]
    _, period, score, closure = find_loop(masks)
    print(f"source loop: period={period} loop-mean={score:.3f} closure={closure:.3f}")
    needed = 2 * period + TRIM_MIN_MARGIN
    if needed > TRIM_MAX_FRAMES:
        raise SystemExit(
            f"period {period} needs a {needed}-frame trim window for two "
            f"instances + substitution margin, over the TRIM_MAX_FRAMES "
            f"{TRIM_MAX_FRAMES} cost cap — slow cycles need a deliberate "
            f"TRIM_MAX_FRAMES raise, not a silent longer bill"
        )

    # Anchor the trim on a loop start that leaves the full window.
    start_max = len(frames) - needed
    if start_max < 0:
        raise SystemExit(
            f"clip of {len(frames)} frames cannot hold 2 loops of period "
            f"{period} + margin — substitution headroom would be lost"
        )
    start, score = best_loop_start(masks, period, start_max=start_max)
    closure = mask_iou(masks[start], masks[start + period])
    if score < LOOP_MEAN_MIN or closure < CLOSURE_MIN:
        raise SystemExit(
            f"trim-anchored loop at {start} scores loop-mean {score:.3f} / "
            f"closure {closure:.3f} — below the registration gates"
        )
    length = min(TRIM_MAX_FRAMES, len(frames) - start)
    print(f"trim: start={start} length={length} loop-mean={score:.3f}")

    fps = probe(source).fps
    master = work / f"master_{args.motion}_{args.family}.mp4"
    trim(source, start, start + length - 1, fps, master)

    trimmed = extract_frames(master, work / "frames_master")
    if len(trimmed) != length:
        raise SystemExit(f"trim produced {len(trimmed)} frames, expected {length}")
    tmasks = [silhouette_mask(img) for img in keyed_frames(trimmed)]
    tstart, tscore, tclosure = verify_loop(tmasks, period)
    if tscore < LOOP_MEAN_MIN or tclosure < CLOSURE_MIN:
        raise SystemExit(
            f"trimmed master scores loop-mean {tscore:.3f} / closure "
            f"{tclosure:.3f} — re-encode broke the loop?"
        )
    with Image.open(trimmed[0]) as first:
        width, height = first.size

    master_sha = put_object(master.read_bytes())
    print(f"uploaded master to R2: {master_sha}")

    ledger["masters"][f"{args.motion}/{args.family}"] = {
        "motion": args.motion,
        "family": args.family,
        "masterSha256": master_sha,
        "sourceSha256": source_sha,
        "frames": length,
        "fps": fps,
        "width": width,
        "height": height,
        "loop": {
            "start": tstart,
            "period": period,
            "loopMeanIou": round(tscore, 3),
            "closureIou": round(tclosure, 3),
        },
        "approval": args.approval,
        "registeredAt": time.strftime("%Y-%m-%d"),
    }
    LEDGER_PATH.write_text(json.dumps(ledger, ensure_ascii=False, indent=2) + "\n")
    subprocess.run(
        ["pnpm", "exec", "biome", "format", "--write", str(LEDGER_PATH)], check=True
    )
    print(f"registered {args.motion}/{args.family}: {length} frames, "
          f"loop start={tstart} period={period} loop-mean={tscore:.3f} "
          f"closure={tclosure:.3f}")


# ----------------------------------------------------------------- produce


def key_background(img: Image.Image) -> Image.Image:
    """Alpha out a reference cell's background, whichever kind it is.

    Green-dominant border → the lane's green-wear-safe chroma key (a stand
    cell rebuilt from a green take). Anything else → border-connected flood
    fill on color distance to the border median: an A-pose on white must
    keep its white shirt, so only border-REACHABLE background pixels may go
    transparent (a global distance threshold would erase the shirt too).
    """
    rgba = img.convert("RGBA")
    a = np.asarray(rgba).astype(int)
    border = border_pixels(a)
    if ((border[:, 1] - np.maximum(border[:, 0], border[:, 2])) >= 40).mean() > 0.5:
        return chroma_key_greenwear(rgba)
    background = np.median(border[:, :3], axis=0)
    distance = np.sqrt(((a[:, :, :3] - background) ** 2).sum(axis=2))
    candidate = distance < BACKGROUND_KEY_DISTANCE
    reachable = np.zeros_like(candidate)
    stack = [
        (y, x)
        for y in range(a.shape[0])
        for x in (0, a.shape[1] - 1)
        if candidate[y, x]
    ] + [
        (y, x)
        for x in range(a.shape[1])
        for y in (0, a.shape[0] - 1)
        if candidate[y, x]
    ]
    for seed in stack:
        reachable[seed] = True
    while stack:
        y, x = stack.pop()
        for ny, nx in ((y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)):
            if (
                0 <= ny < a.shape[0]
                and 0 <= nx < a.shape[1]
                and candidate[ny, nx]
                and not reachable[ny, nx]
            ):
                reachable[ny, nx] = True
                stack.append((ny, nx))
    out = np.asarray(rgba).copy()
    out[:, :, 3] = np.where(reachable, 0, out[:, :, 3])
    return Image.fromarray(out.astype(np.uint8))


def squarify_identity(path: Path, dest: Path) -> Path:
    """Pad the identity image square with its own background color (recipe)."""
    img = Image.open(path).convert("RGB")
    background = tuple(
        int(v) for v in np.median(border_pixels(np.asarray(img).astype(int)), axis=0)
    )
    side = max(img.size)
    canvas = Image.new("RGB", (side, side), background)
    canvas.paste(img, ((side - img.width) // 2, (side - img.height) // 2))
    canvas.save(dest)
    return dest


def validated_order(path: Path) -> dict:
    order = json.loads(path.read_text())
    order_id = order["id"]
    if (
        ORDER_ID_PATTERN.fullmatch(order_id) is None
        or order_id.startswith(REGISTER_WORKDIR_PREFIX)
    ):
        raise SystemExit(
            f"invalid order id {order_id!r} — lowercase slug ([a-z0-9.-]) "
            f"not starting with {REGISTER_WORKDIR_PREFIX!r}"
        )
    # The validated default becomes the used value by construction — and the
    # report's embedded order then records what actually ran.
    resolution = order.setdefault("resolution", DEFAULT_RESOLUTION)
    if resolution not in fal_client.WAN_ANIMATE_RATES:
        raise SystemExit(
            f"unsupported resolution {resolution!r} — one of "
            f"{sorted(fal_client.WAN_ANIMATE_RATES)}"
        )
    return order


def cmd_produce(args: argparse.Namespace) -> None:
    t0 = time.time()
    order = validated_order(args.order)
    work = args.workdir / order["id"]
    work.mkdir(parents=True, exist_ok=True)

    ledger = load_ledger()
    ledger_key = f"{order['motion']}/{order['family']}"
    master_meta = ledger["masters"].get(ledger_key)
    if master_meta is None:
        raise SystemExit(
            f"no master registered for {ledger_key} — run `register` first "
            f"(available: {sorted(ledger['masters'])})"
        )
    period = master_meta["loop"]["period"]

    master = fetch_r2(master_meta["masterSha256"], work / "master.mp4")
    identity_raw = resolve_input(order["identity"], work, "identity")
    identity = squarify_identity(identity_raw, work / "identity_square.png")

    # Reference cell (the character's stand or A-pose) drives scale, hair
    # reference and the palette-drift gate — prepared BEFORE the paid run so
    # a broken reference fails while the order still costs nothing.
    stand_raw = resolve_input(order["standSource"], work, "stand")
    stand = trim_cell(key_background(Image.open(stand_raw)))
    stand = scaled(stand, STAND_WORK_HEIGHT / stand.height)
    reference = hair_reference(stand)

    resolution = order["resolution"]
    est = fal_client.estimate_cost(
        fal_client.WAN_ANIMATE_REPLACE,
        resolution,
        master_meta["frames"],
        master_meta["frames"] / master_meta["fps"],
    )
    jobs = fal_client.FalJobs(work, args.budget)
    payload = {
        "video_url": jobs.upload(master),
        "image_url": jobs.upload(identity),
        "resolution": resolution,
    }
    if order.get("useTurbo"):
        payload["use_turbo"] = True
    print(f"[{order['id']}] replace {ledger_key} — {master_meta['frames']} frames, "
          f"est ${est:.3f}")
    result = jobs.run(order["id"], fal_client.WAN_ANIMATE_REPLACE, payload, est)
    replace_mp4 = jobs.download(
        order["id"], result["video"]["url"], dest=work / "replace-output.mp4"
    )

    frame_paths = extract_frames(replace_mp4, work / "frames")
    if len(frame_paths) != master_meta["frames"]:
        # Hard gate: every downstream step (phase candidates, the montage's
        # per-index master comparison) assumes the 1:1 frame correspondence
        # replace promises; a longer output would even index past the
        # master's frames after all quality gates passed.
        raise SystemExit(
            f"replace output has {len(frame_paths)} frames vs master "
            f"{master_meta['frames']} — timing inheritance broke; retake "
            "under a new key"
        )
    assert_green_background(frame_paths)
    frames = keyed_frames(frame_paths)
    masks = [silhouette_mask(img) for img in frames]

    # Loop verification: the period is inherited from the master; only the
    # quality needs re-proving on the generated frames. verify_loop's best
    # start is the GATE anchor; its consistency scan samples the whole
    # cycle (every CONSISTENCY_STRIDE-th phase pair over one full period),
    # so the gate covers the cycle regardless of where the cells anchor.
    start, loop_mean, closure = verify_loop(masks, period)
    print(f"loop verify: start={start} (master {master_meta['loop']['start']}) "
          f"period={period} loop-mean={loop_mean:.3f} closure={closure:.3f}")
    if loop_mean < OUTPUT_LOOP_MEAN_MIN or closure < OUTPUT_CLOSURE_MIN:
        raise SystemExit(
            f"replace output scores loop-mean {loop_mean:.3f} / closure "
            f"{closure:.3f} (floors {OUTPUT_LOOP_MEAN_MIN} / "
            f"{OUTPUT_CLOSURE_MIN}) — retake (new key) or re-check the master"
        )

    scores = [eye_openness_score(img) for img in frames]
    cells_n = order.get("cells", DEFAULT_CELLS)
    # Cells anchor on the MASTER's registered loop start: the output is
    # frame-synced to the master, so this keeps the pose grid canonical —
    # every character produced from one master gets the same pose per slot
    # (anchoring on verify_loop's start would rotate the cycle whenever the
    # two starts differ).
    chosen, suspects = select_cells(
        scores, master_meta["loop"]["start"], period, cells_n
    )
    print(f"cells: {chosen}")
    if suspects:
        print(f"blink suspects (visual gate must confirm): {suspects}")

    # Normalize the video cells to the reference cell's scale by the median
    # hair-blob ratio (rotation-invariant), then gate each cell.
    raw_cells = [trim_cell(frames[i]) for i in chosen]
    ratios = [hair_stats(c, reference.mean)[2] / reference.scale for c in raw_cells]
    normalize = 1.0 / float(np.median(ratios))
    cells = [scaled(c, normalize) for c in raw_cells]

    prefix = order.get("posePrefix", "dance")
    pose_names = [f"{prefix}-{chr(97 + i)}" for i in range(cells_n)]
    failures: list[str] = []
    necks: dict[str, list[int]] = {}
    import_scale = STAND_HEIGHT_PX / stand.height
    necks["stand"] = [
        round(reference.centroid_x * import_scale),
        round((reference.top_y + reference.head_depth) * import_scale),
    ]
    for pose, cell in zip(pose_names, cells):
        cell_failures, neck = check_gesture_cell(reference, import_scale, pose, cell)
        failures += cell_failures
        necks[pose] = neck
    if failures:
        for failure in failures:
            print(f"  - {failure}", file=sys.stderr)
        raise SystemExit("compose gates failed")

    # The sheet ships with a TRANSPARENT background, not the walk line's
    # green: a green-wearing character (the otaku's plaid shirt) would be
    # re-eaten by the importer's green key, while alpha passes through it
    # untouched (import-avatar-sheet keeps existing alpha-0 pixels).
    all_cells = [stand, *cells]
    cell_w = max(c.width for c in all_cells) + CELL_PAD
    cell_h = max(c.height for c in all_cells) + CELL_PAD
    sheet = Image.new("RGBA", (cell_w * len(all_cells), cell_h), (0, 0, 0, 0))
    for i, cell in enumerate(all_cells):
        x = i * cell_w + (cell_w - cell.width) // 2
        sheet.paste(cell, (x, cell_h - cell.height), cell)
    sheet_path = work / "sheet-original.png"
    sheet.save(sheet_path)

    # Verdict material: master-vs-output montage, 96px loop, blink strip.
    master_frames = keyed_frames(extract_frames(master, work / "frames_master"))
    master_cells = [trim_cell(master_frames[i]) for i in chosen]
    montage_rows(
        [preview_cells(master_cells), preview_cells(cells)],
        work / "montage_master_vs_output.png",
    )
    loop_video(cells, work / "loop_96px.mp4")
    face_strip(frames, chosen, scores, work / "face_strip.png")

    report = {
        "order": order,
        "master": ledger_key,
        "masterSha256": master_meta["masterSha256"],
        "estimatedCost": est,
        "loop": {
            "start": start,
            "period": period,
            "loopMeanIou": round(loop_mean, 3),
            "closureIou": round(closure, 3),
        },
        "cells": chosen,
        "blinkSuspects": suspects,
        "poses": ["stand", *pose_names],
        "grid": {"cols": len(all_cells), "rows": 1},
        "standHeightPx": STAND_HEIGHT_PX,
        "neckAnchors": necks,
        "sheet": str(sheet_path),
        "minutes": round((time.time() - t0) / 60, 1),
    }
    (work / "lane-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    )
    print(f"done {order['id']} in {report['minutes']}m est ${est:.3f} — "
          f"sheet {sheet_path}, report {work / 'lane-report.json'}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    register = sub.add_parser("register", help="register an approved take as a master")
    register.add_argument("--motion", required=True)
    register.add_argument("--family", required=True, help="silhouette family (boy/girl/...)")
    register.add_argument("--source", required=True, help="R2 sha256 or local path")
    register.add_argument("--approval", required=True,
                          help="where the owner approved this take (provenance)")
    register.add_argument("--workdir", type=Path, default=Path("/tmp/kaede-fal-lane"))

    produce = sub.add_parser("produce", help="run one order (発注書) end to end")
    produce.add_argument("order", type=Path)
    produce.add_argument("--workdir", type=Path, default=Path("/tmp/kaede-fal-lane"))
    produce.add_argument("--budget", type=float, default=1.0,
                         help="USD stop for the order's workdir")

    costs = sub.add_parser("costs", help="fal balance + recent gateway requests")
    costs.add_argument("--limit", type=int, default=20)

    args = parser.parse_args()
    if args.command == "register":
        cmd_register(args)
    elif args.command == "produce":
        cmd_produce(args)
    elif args.command == "costs":
        fal_client.print_costs(args.limit)


if __name__ == "__main__":
    main()
