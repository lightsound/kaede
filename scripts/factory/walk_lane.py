#!/usr/bin/env python3
"""Walk-sheet production from registered master takes (①d 論点 6 — the
2026-08-12 owner ruling unifying every walk sheet onto preset-motion
masters; the wan-i2v prompt-acting walk lane is retired).

One registered master per motion × silhouette family (master_takes.json,
itself cast from a Meshy preset motion's 3D reference — Meshy = the motion
mold, used once per new motion) is the single source of walk choreography.
Two production modes:

- `extract`: the sheet's character IS the master's character, so the four
  walk cells are cut straight from the master take — no model call, no
  charge (運転知見 19, the danceMaster precedent). The walk import
  recomposes every head from the sheet's committed stand cell, so the
  master's video-drawn head never ships.
- `replace`: fal wan-2.2 animate/replace transfers the master's
  choreography onto another identity (the sheet's stand cell, squared on
  its own green). Inherits the master's frame timing 1:1 (PR #101), and
  the master must be silhouette-matched to the identity (運転知見 18).

Selection runs the drift-aware cycle scan (cycle_scan.py) with the
ledger's machine-known period and no head skip, over the full walk gate
stack: head consistency, palette drift vs the sheet's own stand, leg
phase (skipped for carry sheets — gentle same-sign strides by spec), and
the ①d 論点 6 neck-junction gate. Composition is compose_walk_sheet
(component erase + alpha_composite — the girl neck-break fixes).

The lane writes the green 5-cell sheet in place and records provenance
into the order (walkMaster / walkMasterSha256 / walkCells); the standard
import + art lint (`run_avatar.py <order> --from-stage import`) stays the
authoritative gate afterwards.

Usage:
    python3 scripts/factory/walk_lane.py produce \
        packages/client/src/game.package/avatar/order.json \
        --master walk/boy --mode extract [--workdir DIR] [--budget 0.5]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
import time
from pathlib import Path

from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

from factory import fal_client  # noqa: E402
from factory.compose_sheet import (  # noqa: E402
    chroma_key,
    compose_native_sheet,
    compose_walk_sheet,
    content_bbox,
)
from factory.cycle_scan import scan_clip  # noqa: E402
from factory.loop_scan import silhouette_mask, verify_loop  # noqa: E402
from factory.replace_lane import (  # noqa: E402
    OUTPUT_CLOSURE_MIN,
    OUTPUT_LOOP_MEAN_MIN,
    assert_green_background,
    fetch_r2,
    keyed_frames,
    load_ledger,
    squarify_identity,
)
from factory.verdict_material import loop_video, montage_rows, preview_cells  # noqa: E402
from factory.video import extract_frames  # noqa: E402
from r2_originals import resolve_asset_path, resolve_original, validate_order_path  # noqa: E402

ASSET_ROOT = ROOT / "packages/client/src/game.package"
# compose_walk_sheet's working height: master/video bodies above it are
# normalized down to it, so the stand is pre-scaled to the same height —
# the committed lane's regime (every cell at one working scale).
WORK_HEIGHT = 400
DEFAULT_RESOLUTION = "720p"
SEEDVR_UPSCALE_IMAGE = "fal-ai/seedvr/upscale/image"


def effective_flip(order: dict, cli_flip: bool) -> bool:
    """The produce run's flip decision: the CLI flag OR the order's recorded
    `walkLane.flip`. The record exists so a REPLAY of `produce` (no flag)
    reproduces the committed sheet instead of silently rebuilding the
    face-versus-body chimera and dropping the record (Bugbot, PR #128).
    Un-flipping a sheet on purpose means editing the order first."""
    return cli_flip or bool((order.get("walkLane") or {}).get("flip"))


def mirror_clip(frames_dir: Path) -> int:
    """Mirror every extracted frame in place; returns the frame count.

    The wan-animate-2 master lineage (walk/boy 1a003e99…・walk-carry/boy
    d53b0400…) is cast from bpy green references that face the OPPOSITE of
    the committed 2D canon (運転知見 38 — machine-verified by head mirror
    correlation: stand head vs master head 0.46 unflipped / 0.73 flipped).
    Extracting those masters verbatim pastes the canon-facing stand head
    onto a mirrored body — the owner-reported "face looks away from the
    walking direction" chimera. Mirroring the whole clip BEFORE the cycle
    scan restores the canon direction deterministically ($0), and every
    downstream gate (foot phase, head consistency, junction) measures the
    geometry that actually ships.
    """
    paths = sorted(frames_dir.glob("*.png"))
    for path in paths:
        ImageOps.mirror(Image.open(path)).save(path)
    return len(paths)


def stand_cell_of_sheet(order: dict, order_path: Path, dest: Path) -> Path:
    """The sheet's committed stand cell (identity anchor), trimmed and keyed,
    scaled to the compose working height."""
    base = order_path.parent
    sheet = Image.open(
        resolve_original(base, order["sheet"], order.get("originals", {}), ASSET_ROOT)
    )
    grid = order["grid"]
    index = order["poses"].index("stand")
    w, h = sheet.size
    col, row = index % grid["cols"], index // grid["cols"]
    cell = sheet.crop(
        (
            col * w // grid["cols"],
            row * h // grid["rows"],
            (col + 1) * w // grid["cols"],
            (row + 1) * h // grid["rows"],
        )
    )
    keyed = chroma_key(cell)
    keyed = keyed.crop(content_bbox(keyed))
    if keyed.height != WORK_HEIGHT:
        scale = WORK_HEIGHT / keyed.height
        keyed = keyed.resize(
            (max(1, round(keyed.width * scale)), WORK_HEIGHT), Image.LANCZOS
        )
    keyed.save(dest)
    return dest


def reference_meta_of(master_key: str) -> dict:
    """master_models.json motion green reference, reshaped to the take-meta
    fields cmd_produce consumes (masterSha256/frames/fps/loop)."""
    motion, family = master_key.split("/")
    ledger = json.loads(
        (Path(__file__).resolve().parent / "master_models.json").read_text()
    )
    try:
        ref = ledger["models"][family]["motions"][motion]["reference"]
    except KeyError:
        raise SystemExit(
            f"no green reference registered for {master_key} — run "
            "model_ledger.py register-motion first"
        )
    return {
        "masterSha256": ref["sha256"],
        "frames": ref["frames"],
        "fps": ref["fps"],
        "loop": ref["loop"],
    }


# The bpy mannequin's measured frame fractions (subject height 43% of the
# frame, top margin 7% — the spike_r2v_bench calibration, 運転知見 35): the
# wan replace output inherits the IDENTITY's framing, so a full-bleed
# identity leaves the erased mannequin's region to ghost. Framing-matching
# the identity puts the character exactly where the mannequin is.
MATCHED_HEIGHT_FRAC = 0.43
MATCHED_TOP_FRAC = 0.07


def matched_identity_of_stand(
    stand_raw: Path, dest: Path, jobs: "fal_client.FalJobs"
) -> Path:
    """The sheet's stand cell, SeedVR2-4x'd and re-framed to the mannequin
    box on green. The 4x pass is the STANDARD identity preprocessing
    (運転知見 33 — identity authority comes from the artwork's information
    content: the un-upscaled 400px pants-carry stand let wan drift the
    proportions off-chibi, t3 2026-08-20). ~$0.01 per cast."""
    cell = Image.open(stand_raw).convert("RGBA")
    green_src = dest.with_name("identity_green_src.png")
    canvas = Image.new("RGB", cell.size, (0, 255, 0))
    canvas.paste(cell, (0, 0), cell)
    canvas.save(green_src)
    est = max(cell.width * cell.height * 16 / 1e6 * 0.001, 0.01)
    result = jobs.run(
        "identity-seedvr-4x",
        SEEDVR_UPSCALE_IMAGE,
        {
            "image_url": jobs.upload(green_src),
            "upscale_mode": "factor",
            "upscale_factor": 4,
        },
        est,
    )
    big_path = jobs.download(
        "identity-seedvr-4x", result["image"]["url"], dest=dest.with_name("identity_4x.png")
    )
    big = Image.open(big_path).convert("RGB")
    keyed = chroma_key(big)
    crop = keyed.crop(content_bbox(keyed))
    side = max(720, round(crop.height / MATCHED_HEIGHT_FRAC))
    target_h = round(side * MATCHED_HEIGHT_FRAC)
    scale = target_h / crop.height
    small = crop.resize(
        (max(1, round(crop.width * scale)), target_h), Image.LANCZOS
    )
    out = Image.new("RGB", (side, side), (0, 255, 0))
    out.paste(small, ((side - small.width) // 2, round(side * MATCHED_TOP_FRAC)), small)
    out.save(dest)
    return dest


def seedvr_4x_stand(stand_raw: Path, work: Path, jobs: "fal_client.FalJobs") -> Path:
    """SeedVR2 image-4x of the stand cell on white (運転知見 33 standard
    identity preprocessing — the artwork's information content is what
    holds wan to the identity). Returns a stand-cell-shaped RGBA png."""
    cell = Image.open(stand_raw).convert("RGBA")
    src = work / "identity_white_src.png"
    canvas = Image.new("RGB", cell.size, (255, 255, 255))
    canvas.paste(cell, (0, 0), cell)
    canvas.save(src)
    est = max(cell.width * cell.height * 16 / 1e6 * 0.001, 0.01)
    result = jobs.run(
        "identity-seedvr-4x",
        SEEDVR_UPSCALE_IMAGE,
        {
            "image_url": jobs.upload(src),
            "upscale_mode": "factor",
            "upscale_factor": 4,
        },
        est,
    )
    return jobs.download(
        "identity-seedvr-4x", result["image"]["url"], dest=work / "identity_4x_white.png"
    )


def replace_frames(
    order: dict, master: Path, master_meta: dict, stand_raw: Path, work: Path, budget: float,
    *, matched: bool = False, identity_4x: bool = False,
) -> tuple[Path, int]:
    """fal wan-replace transfer of the master onto the sheet's stand identity;
    returns (gated frames directory, verified loop start) — the
    replace_lane produce recipe."""
    resolution = order.get("walkResolution", DEFAULT_RESOLUTION)
    est = fal_client.estimate_cost(
        fal_client.WAN_ANIMATE_REPLACE,
        resolution,
        master_meta["frames"],
        master_meta["frames"] / master_meta["fps"],
    )
    jobs = fal_client.FalJobs(work, budget)
    if matched:
        identity = matched_identity_of_stand(
            stand_raw, work / "identity_matched_green.png", jobs
        )
    elif identity_4x:
        identity = squarify_identity(
            seedvr_4x_stand(stand_raw, work, jobs), work / "identity_square.png"
        )
    else:
        identity = squarify_identity(stand_raw, work / "identity_square.png")
    payload = {
        "video_url": jobs.upload(master),
        "image_url": jobs.upload(identity),
        "resolution": resolution,
    }
    print(f"replace — {master_meta['frames']} frames, est ${est:.3f}")
    result = jobs.run(order["id"], fal_client.WAN_ANIMATE_REPLACE, payload, est)
    replace_mp4 = jobs.download(
        order["id"], result["video"]["url"], dest=work / "replace-output.mp4"
    )
    frame_paths = extract_frames(replace_mp4, work / "frames")
    if len(frame_paths) != master_meta["frames"]:
        raise SystemExit(
            f"replace output has {len(frame_paths)} frames vs master "
            f"{master_meta['frames']} — timing inheritance broke; retake "
            "under a new key"
        )
    assert_green_background(frame_paths)
    masks = [silhouette_mask(img) for img in keyed_frames(frame_paths)]
    start, loop_mean, closure = verify_loop(masks, master_meta["loop"]["period"])
    print(f"loop verify: start={start} loop-mean={loop_mean:.3f} closure={closure:.3f}")
    if loop_mean < OUTPUT_LOOP_MEAN_MIN or closure < OUTPUT_CLOSURE_MIN:
        raise SystemExit(
            f"replace output scores loop-mean {loop_mean:.3f} / closure "
            f"{closure:.3f} (floors {OUTPUT_LOOP_MEAN_MIN} / {OUTPUT_CLOSURE_MIN})"
            " — retake (new key) or re-check the master"
        )
    return work / "frames", start


def sheet_cells_shipping(sheet_path: Path, columns: int) -> list[Image.Image]:
    """The composed sheet's cells keyed, trimmed and import-scaled
    (192px = the 4x shipping scale of the factory-v2 step-1 ruling)."""
    sheet = Image.open(sheet_path).convert("RGBA")
    cell_w = sheet.width // columns
    cells = []
    for i in range(columns):
        cell = chroma_key(sheet.crop((i * cell_w, 0, (i + 1) * cell_w, sheet.height)))
        cells.append(cell.crop(content_bbox(cell)))
    scale = 192 / cells[0].height
    return [
        c.resize(
            (max(1, round(c.width * scale)), max(1, round(c.height * scale))),
            Image.LANCZOS,
        )
        for c in cells
    ]


def cmd_produce(args: argparse.Namespace) -> None:
    t0 = time.time()
    order_path = validate_order_path(args.order, ASSET_ROOT)
    order = json.loads(order_path.read_text())
    flip = effective_flip(order, args.flip)
    # Video-native cells (owner ruling 2026-08-20「24 で進めて」): ship the
    # master frames as-is — no head composite, no prescribed bob. Recorded
    # into walkLane.head so a replay reproduces the committed sheet.
    native = args.native or (order.get("walkLane") or {}).get("head") == "native"
    work = args.workdir / order["id"]
    work.mkdir(parents=True, exist_ok=True)

    driving = getattr(args, "driving", "take")
    if driving == "reference":
        # Mannequin driving (the master-CASTING recipe): the bpy green
        # reference has no clothing to map away, so outfits far from the
        # master's (the pants variant's bare torso — wan hallucinated a
        # carried object t1 / a glass pillar t2 when driven by the dressed
        # master take, 2026-08-20) transfer without invention. Identity
        # must be framing-matched to the mannequin box (運転知見 35).
        master_meta = reference_meta_of(args.master)
    else:
        ledger = load_ledger()
        master_meta = ledger["masters"].get(args.master)
        if master_meta is None:
            raise SystemExit(
                f"no master registered for {args.master} — run replace_lane.py "
                f"register first (available: {sorted(ledger['masters'])})"
            )
    period = master_meta["loop"]["period"]
    master = fetch_r2(master_meta["masterSha256"], work / "master.mp4")
    stand_raw = stand_cell_of_sheet(order, order_path, work / "stand_raw.png")

    take_sha: str | None = None
    if args.mode == "extract":
        frames_dir = work / "frames"
        frame_paths = extract_frames(master, frames_dir)
        assert_green_background(frame_paths)
        # The ledger's verified loop start bounds the scan: the girl master
        # eases in for 31 frames before its loop, and cells cut from that
        # region passed every pixel gate while holding no contact/passing
        # structure (the inverted-bob差し戻し, 2026-08-13).
        loop_start = master_meta["loop"]["start"]
    elif (take_sha := (order.get("walkLane") or {}).get("takeSha256")) and not args.retake:
        # A committed replace take is content-addressed in R2: a REPLAY
        # rebuilds the sheet from the exact take that shipped, $0, instead
        # of re-rolling the transfer. --retake forces a fresh paid roll.
        take = fetch_r2(take_sha, work / "take.mp4")
        frame_paths = extract_frames(take, work / "frames")
        assert_green_background(frame_paths)
        masks = [silhouette_mask(img) for img in keyed_frames(frame_paths)]
        loop_start, loop_mean, closure = verify_loop(
            masks, master_meta["loop"]["period"]
        )
        print(
            f"replay from recorded take {take_sha[:12]}… "
            f"loop-mean={loop_mean:.3f} closure={closure:.3f}"
        )
        frames_dir = work / "frames"
    else:
        frames_dir, loop_start = replace_frames(
            order, master, master_meta, stand_raw, work, args.budget,
            matched=driving == "reference",
            identity_4x=args.identity_4x,
        )
        take_sha = hashlib.sha256(
            (work / "replace-output.mp4").read_bytes()
        ).hexdigest()

    if flip:
        print(f"mirrored {mirror_clip(frames_dir)} frames (canon facing — 運転知見 38)")

    # Carry sheets stride gently with same-sign contacts by spec (the
    # run_lint rule) — the leg-phase opposition gate only applies to swing
    # walks. Every other gate (junction included) applies to both.
    scan_kwargs: dict = {}
    drift_max = (order.get("lint") or {}).get("driftMax")
    if drift_max is not None:
        # Entry-scoped, owner-ruled drift calibration (運転知見 37/39 —
        # check_palette_drift's distance_max doc). Lives in the committed
        # order so a re-run reproduces the ruling.
        scan_kwargs["drift_distance_max"] = float(drift_max)
    selected = scan_clip(
        stand_raw,
        frames_dir,
        pinned_contact=args.contact,
        period=period,
        loop_start=loop_start,
        skip_head_seconds=0,
        expect_leg_phase=not order.get("handLayer"),
        cells=args.cells,
        native=native,
        **scan_kwargs,
    )
    chosen = {pose: int(paths[0].stem.split("_")[1]) for pose, paths in selected.items()}
    print(f"cells: {chosen}")

    sheet_path = resolve_asset_path(order_path.parent, order["sheet"], ASSET_ROOT)
    (compose_native_sheet if native else compose_walk_sheet)(stand_raw, selected, sheet_path)
    print(f"wrote {sheet_path}")

    # Provenance into the order (the danceMaster rule: the ledger sha is
    # recorded so a silently different master cannot re-anchor the cells).
    order["walkMaster"] = args.master
    order["walkMasterSha256"] = master_meta["masterSha256"]
    lane: dict = {"mode": args.mode, "cells": chosen}
    if take_sha:
        lane["takeSha256"] = take_sha
    if driving != "take":
        lane["driving"] = driving
    if flip:
        lane["flip"] = True
    if native:
        lane["head"] = "native"
    order["walkLane"] = lane
    order_path.write_text(json.dumps(order, ensure_ascii=False, indent=2) + "\n")
    subprocess.run(
        ["pnpm", "exec", "biome", "format", "--write", str(order_path)], check=True
    )

    # Verdict material: master cells vs composed cells + the 96px loop.
    cells = sheet_cells_shipping(sheet_path, len(selected) + 1)
    master_cells = []
    for pose in sorted(selected):
        keyed = chroma_key(Image.open(selected[pose][0]))
        master_cells.append(keyed.crop(content_bbox(keyed)))
    montage_rows(
        [preview_cells(master_cells), preview_cells(cells[1:])],
        work / "montage_master_vs_sheet.png",
    )
    loop_video(cells[1:], work / "loop_96px.mp4")

    report = {
        "order": order["id"],
        "master": args.master,
        "masterSha256": master_meta["masterSha256"],
        "mode": args.mode,
        "period": period,
        "cells": chosen,
        "sheet": str(sheet_path),
        "minutes": round((time.time() - t0) / 60, 1),
    }
    (work / "lane-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    )
    print(
        f"done {order['id']} in {report['minutes']}m — sheet {sheet_path}, "
        f"verdict {work / 'montage_master_vs_sheet.png'}"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    produce = sub.add_parser("produce", help="regenerate one walk sheet's walk cells")
    produce.add_argument("order", type=Path, help="the sheet's order.json")
    produce.add_argument("--master", required=True, help="ledger key motion/family")
    produce.add_argument(
        "--mode",
        choices=["extract", "replace"],
        required=True,
        help="extract = cut from the master (its own character, no charge); "
        "replace = fal transfer onto the sheet's stand identity",
    )
    produce.add_argument(
        "--contact",
        type=int,
        default=None,
        help="pin the cycle scan to one contact frame index (visual-gate override)",
    )
    produce.add_argument(
        "--flip",
        action="store_true",
        help="mirror the master clip before scanning (mirrored-lineage masters "
        "— 運転知見 38; recorded into the order's walkLane for reproducibility)",
    )
    produce.add_argument(
        "--cells",
        type=int,
        default=4,
        help="walk cells per stride (dense sheets ship 24; legacy 4). "
        "The master's loop period should divide by this evenly — an uneven "
        "split reads as a one-beat stutter (the 25→12 measurement, 2026-08-20)",
    )
    produce.add_argument(
        "--retake",
        action="store_true",
        help="force a fresh paid replace roll even when the order records a "
        "committed takeSha256 (replays reuse the R2 take by default, $0)",
    )
    produce.add_argument(
        "--identity-4x",
        action="store_true",
        help="SeedVR2-4x the stand cell before squarifying (運転知見 33 "
        "standard — take-driven replaces of low-information identities "
        "hallucinate around ambiguous regions, e.g. the bare-torso pants "
        "variants; ~$0.01)",
    )
    produce.add_argument(
        "--driving",
        choices=["take", "reference"],
        default="take",
        help="replace-mode driving video: take = the registered master take; "
        "reference = the motion's bpy green mannequin (the master-casting "
        "recipe — for outfits too far from the master's to map cleanly, "
        "e.g. the bare-torso pants variants; identity is framing-matched)",
    )
    produce.add_argument(
        "--native",
        action="store_true",
        help="ship the master frames as-is (no head composite / prescribed "
        "bob — the 2026-08-20 video-native ruling); recorded as walkLane.head",
    )
    produce.add_argument("--workdir", type=Path, default=Path("/tmp/kaede-walk-lane"))
    produce.add_argument("--budget", type=float, default=0.5,
                         help="USD stop for replace mode")
    args = parser.parse_args()
    if args.command == "produce":
        cmd_produce(args)


if __name__ == "__main__":
    main()
