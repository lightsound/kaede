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
3. machine-verified loop closure (silhouette IoU ≥ loop_scan.CLOSURE_MIN)
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
              green sheet + neck anchors + verdict material
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
import hashlib
import json
import re
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

from factory import fal_client  # noqa: E402
from factory.anchors import structure_neck  # noqa: E402
from factory.art_lint import check_palette_drift  # noqa: E402
from factory.blink import eye_openness_score, select_cells  # noqa: E402
from factory.compose_sheet import content_bbox  # noqa: E402
from factory.loop_scan import (  # noqa: E402
    CLOSURE_MIN,
    LOOP_MEAN_MIN,
    best_loop_start,
    find_loop,
    mask_iou,
    silhouette_mask,
    verify_loop,
)
from r2_originals import _request, object_key, sha256_of  # noqa: E402

LEDGER_PATH = Path(__file__).resolve().parent / "master_takes.json"
SHA256_PATTERN = re.compile(r"[0-9a-f]{64}\Z")
OPAQUE = 128

# One loop + substitution margin: 97 frames = 6.0625 billed video-seconds
# ($0.2425 at 480p). The margin must hold ≥ 2 loop instances so every cell
# slot has a phase-equivalent substitute (blink.py).
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

# Sheet composition (the gesture lane's working scale and gates).
STAND_WORK_HEIGHT = 400
STAND_HEIGHT_PX = 96
CELL_PAD = 8
# Generative takes redraw hair slightly (~9% linear measured on the wave
# take); the tolerance catches scale mistakes, not redraw noise.
HAIR_SCALE_TOLERANCE = 0.15
HAIR_COLOR_DISTANCE = 60
# Border pixels of a green-screen take that must be green-dominant.
GREEN_BORDER_MIN = 0.95
BACKGROUND_KEY_DISTANCE = 40

DEFAULT_CELLS = 8
DEFAULT_RESOLUTION = "480p"
PREVIEW_SCALE = 3
PREVIEW_BACKGROUND = (240, 240, 245)
PREVIEW_FRAME_MS = 100

# Green-wear-safe chroma key. The walk line's key (hard 60 / soft 20 +
# global despill) assumes the character never wears green; the otaku's
# plaid shirt broke that (e2e 2026-08-11: shirt dominance 20-60 was eaten,
# despill grayed the rest). Measured separation on replace outputs:
# background green dominance ≥ 150, garment greens ≤ 60, edge mixes thinly
# in between — so definite background keys at 100+, the soft zone (20-100)
# only within the edge ring next to definite background, and despill only
# touches that same ring.
KEY_DEFINITE = 100
KEY_SOFT = 20
KEY_RING_PX = 2


def run(cmd: list[str]) -> None:
    print("+", " ".join(cmd), flush=True)
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise SystemExit(f"{cmd[0]} failed: {result.stderr[-800:]}")


def fetch_r2(sha256: str, dest: Path) -> Path:
    """Content-addressed fetch from the originals bucket, hash-verified."""
    if dest.exists() and sha256_of(dest) == sha256:
        return dest
    body = _request(object_key(sha256))
    digest = hashlib.sha256(body).hexdigest()
    if digest != sha256:
        raise SystemExit(f"R2 object {sha256} hashed to {digest} — refusing to use")
    dest.write_bytes(body)
    return dest


def resolve_input(value: str, work: Path, name: str) -> Path:
    """An order input: a 64-hex R2 content address or a local file path."""
    if SHA256_PATTERN.fullmatch(value):
        return fetch_r2(value, work / f"{name}.bin")
    path = Path(value)
    if not path.is_file():
        raise SystemExit(f"{name}: {value} is neither a sha256 nor a local file")
    return path


def extract_frames(video: Path, out_dir: Path) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    for old in out_dir.glob("frame_*.png"):
        old.unlink()
    run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(video), "-vsync", "0",
         str(out_dir / "frame_%04d.png")])
    frames = sorted(out_dir.glob("frame_*.png"))
    if not frames:
        raise SystemExit(f"no frames extracted from {video}")
    return frames


def probe_fps(video: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
         "stream=r_frame_rate", "-of", "csv=p=0", str(video)],
        capture_output=True, text=True, check=True,
    )
    num, _, den = out.stdout.strip().partition("/")
    return float(num) / float(den or 1)


def assert_green_background(frames: list[Path]) -> None:
    """Registration requirement 1: the take is a green-screen clip."""
    for path in (frames[0], frames[len(frames) // 2], frames[-1]):
        a = np.asarray(Image.open(path).convert("RGB")).astype(int)
        border = np.concatenate([a[0], a[-1], a[:, 0], a[:, -1]])
        green = (border[:, 1] - np.maximum(border[:, 0], border[:, 2])) >= 40
        if green.mean() < GREEN_BORDER_MIN:
            raise SystemExit(
                f"{path.name}: only {green.mean():.0%} of the border is green "
                f"— masters must be green-screen takes (chroma-key contract)"
            )


def _dilate(mask: np.ndarray, iterations: int) -> np.ndarray:
    out = mask.copy()
    for _ in range(iterations):
        grown = out.copy()
        for axis, shift in ((0, 1), (0, -1), (1, 1), (1, -1)):
            grown |= np.roll(out, shift, axis=axis)
        out = grown
    return out


def chroma_key_greenwear(img: Image.Image) -> Image.Image:
    """Key the green screen without eating green clothes (see KEY_DEFINITE)."""
    rgba = np.asarray(img.convert("RGBA")).copy()
    r, g, b = (rgba[:, :, i].astype(int) for i in range(3))
    dominance = g - np.maximum(r, b)
    definite = dominance >= KEY_DEFINITE
    ring = _dilate(definite, KEY_RING_PX) & ~definite
    keyed = definite | (ring & (dominance > KEY_SOFT))
    rgba[:, :, 3] = np.where(keyed, 0, rgba[:, :, 3])
    # Despill only the surviving edge ring — a global despill grays out
    # green garments (the importer-side key still does; known limitation).
    despill = ring & ~keyed
    rgba[:, :, 1] = np.where(despill, np.minimum(g, np.maximum(r, b)), g).astype(
        rgba.dtype
    )
    return Image.fromarray(rgba)


def keyed_frames(paths: list[Path]) -> list[Image.Image]:
    return [chroma_key_greenwear(Image.open(p)) for p in paths]


# ---------------------------------------------------------------- register


def load_ledger() -> dict:
    if LEDGER_PATH.exists():
        return json.loads(LEDGER_PATH.read_text())
    return {
        "registrationRequirements": [
            "緑背景(クロマキー前提 — register が機械確認)",
            "オーナー承認済み(approval に承認の出所を記録)",
            "ループ閉包の機械確認済み(シルエット IoU ≥ 0.93 — loop_scan.py)",
        ],
        "canonicalForm": (
            "masterSha256 はトリム済み(1 ループ+位相等価差し替えマージン・"
            "最大 97 コマ ≈ 480p $0.24/replace)の R2 原本。sourceSha256 は"
            "承認テイクの元動画(トレーサビリティ用)。"
        ),
        "masters": {},
    }


def cmd_register(args: argparse.Namespace) -> None:
    work = args.workdir / f"register-{args.motion}-{args.family}"
    work.mkdir(parents=True, exist_ok=True)
    if not args.approval.strip():
        raise SystemExit("--approval must record where the owner approved this take")
    source = resolve_input(args.source, work, "source")
    source_sha = sha256_of(source)

    frames = extract_frames(source, work / "frames_source")
    assert_green_background(frames)
    masks = [silhouette_mask(img) for img in keyed_frames(frames)]
    _, period, score, closure = find_loop(masks)
    print(f"source loop: period={period} loop-mean={score:.3f} closure={closure:.3f}")

    # Anchor the trim on a loop start that leaves substitution headroom
    # beyond the two instances the consistency scan already guarantees.
    start_max = len(frames) - 2 * period - TRIM_MIN_MARGIN
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

    fps = probe_fps(source)
    master = work / f"master_{args.motion}_{args.family}.mp4"
    end = start + length - 1
    run([
        "ffmpeg", "-y", "-loglevel", "error", "-i", str(source),
        "-vf", f"select=between(n\\,{start}\\,{end}),setpts=N/{fps:g}/TB",
        "-r", f"{fps:g}", "-an", "-c:v", "libx264", "-crf", "12",
        "-pix_fmt", "yuv420p", str(master),
    ])

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

    master_sha = sha256_of(master)
    _request(object_key(master_sha), body=master.read_bytes())
    print(f"uploaded master to R2: {master_sha}")

    ledger = load_ledger()
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
    """Alpha out the background: chroma key for green takes, border-connected
    flood fill otherwise (an A-pose on white must keep its white shirt —
    only border-reachable background pixels may go transparent)."""
    rgba = img.convert("RGBA")
    a = np.asarray(rgba).astype(int)
    border = np.concatenate([a[0], a[-1], a[:, 0], a[:, -1]])
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
    a = np.asarray(img).astype(int)
    border = np.concatenate([a[0], a[-1], a[:, 0], a[:, -1]])
    background = tuple(int(v) for v in np.median(border, axis=0))
    side = max(img.size)
    canvas = Image.new("RGB", (side, side), background)
    canvas.paste(img, ((side - img.width) // 2, (side - img.height) // 2))
    canvas.save(dest)
    return dest


def hair_reference(stand: Image.Image) -> tuple[np.ndarray, int]:
    """(mean hair RGB, head depth px) from the reference cell's head band."""
    neck = structure_neck(stand)
    a = np.asarray(stand)
    head_rows = slice(0, int(neck[1] * 0.7))
    opaque = a[head_rows][:, :, 3] > OPAQUE
    hair_px = a[head_rows][:, :, :3][opaque].astype(int)
    if len(hair_px) < 50:
        raise SystemExit("reference cell has no head content above the neck")
    return hair_px.mean(axis=0), neck[1]


def hair_stats(cell: Image.Image, hair_mean: np.ndarray) -> tuple[int, int, float]:
    """(centroid x, top y, sqrt pixel count) of the cell's hair blob —
    rotation-invariant scale signal (the gesture lane's verified metric)."""
    a = np.asarray(cell)
    opaque = a[:, :, 3] > OPAQUE
    rgb = a[:, :, :3].astype(int)
    distance = np.sqrt(((rgb - hair_mean) ** 2).sum(axis=2))
    hairish = opaque & (distance < HAIR_COLOR_DISTANCE)
    ys, xs = np.where(hairish)
    if len(xs) < 50:
        raise SystemExit("hair blob too small — wrong colors or wrong scale")
    return int(xs.mean()), int(ys.min()), float(len(xs)) ** 0.5


def trim_cell(keyed: Image.Image) -> Image.Image:
    return keyed.crop(content_bbox(keyed))


def scaled(cell: Image.Image, scale: float) -> Image.Image:
    if scale == 1.0:
        return cell
    return cell.resize(
        (max(1, round(cell.width * scale)), max(1, round(cell.height * scale))),
        Image.LANCZOS,
    )


def preview_cells(cells: list[Image.Image], height: int = STAND_HEIGHT_PX) -> list[Image.Image]:
    """Game-scale (96px) then nearest-upscaled cells for verdict material."""
    out = []
    reference = max(c.height for c in cells)
    for cell in cells:
        small = scaled(cell, height / reference)
        out.append(
            small.resize(
                (small.width * PREVIEW_SCALE, small.height * PREVIEW_SCALE),
                Image.NEAREST,
            )
        )
    return out


def montage_rows(rows: list[list[Image.Image]], out_path: Path) -> None:
    cell_w = max(c.width for row in rows for c in row) + CELL_PAD
    cell_h = max(c.height for row in rows for c in row) + CELL_PAD
    columns = max(len(row) for row in rows)
    canvas = Image.new("RGB", (cell_w * columns, cell_h * len(rows)), PREVIEW_BACKGROUND)
    for row_i, row in enumerate(rows):
        for col_i, cell in enumerate(row):
            x = col_i * cell_w + (cell_w - cell.width) // 2
            y = row_i * cell_h + (cell_h - cell.height)
            canvas.paste(cell, (x, y), cell if cell.mode == "RGBA" else None)
    canvas.save(out_path)


def face_strip(
    frames: list[Image.Image], indices: list[int], scores: list[float], out_path: Path
) -> None:
    """Head crops of the chosen cells with eye scores — the blink visual gate."""
    tiles = []
    for index in indices:
        keyed = frames[index]
        x0, y0, x1, y1 = content_bbox(keyed)
        head = keyed.crop((x0, y0, x1, y0 + int((y1 - y0) * 0.5)))
        tiles.append((index, head.resize((160, round(head.height * 160 / head.width)))))
    tile_h = max(t.height for _, t in tiles)
    canvas = Image.new("RGB", (164 * len(tiles), tile_h + 18), (255, 255, 255))
    draw = ImageDraw.Draw(canvas)
    for i, (index, tile) in enumerate(tiles):
        canvas.paste(tile, (i * 164 + 2, 18), tile)
        draw.text((i * 164 + 2, 2), f"f{index} eye={scores[index]:.0f}", fill=(0, 0, 0))
    canvas.save(out_path)


def loop_video(cells: list[Image.Image], out_path: Path, loops: int = 3) -> None:
    scratch = out_path.parent / f"{out_path.stem}_frames"
    scratch.mkdir(parents=True, exist_ok=True)
    for old in scratch.glob("*.png"):
        old.unlink()
    previews = preview_cells(cells)
    # libx264 requires even dimensions.
    cell_w = (max(c.width for c in previews) + CELL_PAD + 1) // 2 * 2
    cell_h = (max(c.height for c in previews) + CELL_PAD + 1) // 2 * 2
    counter = 0
    for _ in range(loops):
        for cell in previews:
            canvas = Image.new("RGB", (cell_w, cell_h), PREVIEW_BACKGROUND)
            canvas.paste(cell, ((cell_w - cell.width) // 2, cell_h - cell.height), cell)
            canvas.save(scratch / f"loop_{counter:04d}.png")
            counter += 1
    run([
        "ffmpeg", "-y", "-loglevel", "error",
        "-framerate", f"{1000 / PREVIEW_FRAME_MS:g}",
        "-i", str(scratch / "loop_%04d.png"),
        "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", str(out_path),
    ])


def cmd_produce(args: argparse.Namespace) -> None:
    t0 = time.time()
    order = json.loads(args.order.read_text())
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
    loop_start = master_meta["loop"]["start"]

    master = fetch_r2(master_meta["masterSha256"], work / "master.mp4")
    identity_raw = resolve_input(order["identity"], work, "identity")
    identity = squarify_identity(identity_raw, work / "identity_square.png")

    # Reference cell (the character's stand or A-pose) drives scale, hair
    # reference and the palette-drift gate — prepared BEFORE the paid run so
    # a broken reference fails while the order still costs nothing.
    stand_raw = resolve_input(order["standSource"], work, "stand")
    stand = trim_cell(key_background(Image.open(stand_raw)))
    stand = scaled(stand, STAND_WORK_HEIGHT / stand.height)
    hair_mean, head_depth = hair_reference(stand)
    stand_hair = hair_stats(stand, hair_mean)

    resolution = order.get("resolution", DEFAULT_RESOLUTION)
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
    replace_mp4 = jobs.download(order["id"], result["video"]["url"])

    frame_paths = extract_frames(replace_mp4, work / "frames")
    if len(frame_paths) != master_meta["frames"]:
        raise SystemExit(
            f"output has {len(frame_paths)} frames vs master "
            f"{master_meta['frames']} — timing inheritance broke, so loop "
            f"anchors and cell indices cannot be trusted; retake"
        )
    frames = keyed_frames(frame_paths)
    masks = [silhouette_mask(img) for img in frames]

    # Loop verification: the period is inherited from the master; only the
    # quality needs re-proving on the generated frames.
    start, loop_mean, closure = verify_loop(masks, period)
    print(f"loop verify: start={start} (master {loop_start}) period={period} "
          f"loop-mean={loop_mean:.3f} closure={closure:.3f}")
    if loop_mean < OUTPUT_LOOP_MEAN_MIN or closure < OUTPUT_CLOSURE_MIN:
        raise SystemExit(
            f"replace output scores loop-mean {loop_mean:.3f} / closure "
            f"{closure:.3f} (floors {OUTPUT_LOOP_MEAN_MIN} / "
            f"{OUTPUT_CLOSURE_MIN}) — retake (new key) or re-check the master"
        )

    scores = [eye_openness_score(img) for img in frames]
    cells_n = order.get("cells", DEFAULT_CELLS)
    # Cells anchor on the MASTER's registered loop start: the output is
    # frame-synced to the master, and anchoring on verify_loop's start
    # would rotate the pose phases whenever the two starts differ.
    chosen, suspects = select_cells(scores, loop_start, period, cells_n)
    print(f"cells: {chosen}")
    if suspects:
        print(f"blink suspects (visual gate must confirm): {suspects}")

    raw_cells = [trim_cell(frames[i]) for i in chosen]
    ratios = []
    for cell in raw_cells:
        ratios.append(hair_stats(cell, hair_mean)[2] / stand_hair[2])
    normalize = 1.0 / float(np.median(ratios))
    cells = [scaled(c, normalize) for c in raw_cells]

    prefix = order.get("posePrefix", "dance")
    pose_names = [f"{prefix}-{chr(97 + i)}" for i in range(cells_n)]
    failures: list[str] = []
    necks: dict[str, list[int]] = {}
    import_scale = STAND_HEIGHT_PX / stand.height
    stand_cx, stand_top, _ = stand_hair
    necks["stand"] = [
        round(stand_cx * import_scale),
        round((stand_top + head_depth) * import_scale),
    ]
    for pose, cell in zip(pose_names, cells):
        cx, top, hair_scale = hair_stats(cell, hair_mean)
        ratio = hair_scale / stand_hair[2]
        print(f"{pose}: hair scale ratio {ratio:.3f}")
        if abs(ratio - 1.0) > HAIR_SCALE_TOLERANCE:
            failures.append(
                f"{pose}: hair scale ratio {ratio:.3f} — normalization broke"
            )
        failures += [f"{pose}: {f}" for f in check_palette_drift(stand, cell)]
        necks[pose] = [
            round(cx * import_scale),
            round((top + head_depth) * import_scale),
        ]
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
