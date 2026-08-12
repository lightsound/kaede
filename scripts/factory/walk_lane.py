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
import json
import subprocess
import sys
import time
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

from factory import fal_client  # noqa: E402
from factory.compose_sheet import (  # noqa: E402
    HEAD_BOB_GAIN,
    HEAD_BOB_PHASE,
    chroma_key,
    compose_walk_sheet,
    content_bbox,
)
from factory.cycle_scan import POSES, scan_clip  # noqa: E402
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
DEFAULT_RESOLUTION = "480p"


def bob_profile(order: dict, master_meta: dict) -> tuple[float, int]:
    """Resolve the reproducible per-sheet bob profile.

    The master ledger owns the calibrated default because raw neck amplitude
    is a property of the motion take. Once produced, walkLane records the
    effective values so an existing sheet never changes when another master
    is recalibrated later.
    """
    lane = order.get("walkLane") or {}
    gain = lane.get("headBobGain", master_meta.get("headBobGain", HEAD_BOB_GAIN))
    phase = lane.get("headBobPhase", master_meta.get("headBobPhase", HEAD_BOB_PHASE))
    if isinstance(gain, bool) or not isinstance(gain, (int, float)) or gain < 0:
        raise SystemExit(f"invalid headBobGain {gain!r}; expected a non-negative number")
    if isinstance(phase, bool) or phase not in (-1, 1):
        raise SystemExit(f"invalid headBobPhase {phase!r}; expected -1 or 1")
    return float(gain), int(phase)


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


def replace_frames(
    order: dict, master: Path, master_meta: dict, stand_raw: Path, work: Path, budget: float
) -> Path:
    """fal wan-replace transfer of the master onto the sheet's stand identity;
    returns the gated frames directory (the replace_lane produce recipe)."""
    resolution = order.get("walkResolution", DEFAULT_RESOLUTION)
    est = fal_client.estimate_cost(
        fal_client.WAN_ANIMATE_REPLACE,
        resolution,
        master_meta["frames"],
        master_meta["frames"] / master_meta["fps"],
    )
    identity = squarify_identity(stand_raw, work / "identity_square.png")
    jobs = fal_client.FalJobs(work, budget)
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
    return work / "frames"


def sheet_cells_96(sheet_path: Path) -> list[Image.Image]:
    """The composed sheet's five cells keyed, trimmed and import-scaled."""
    sheet = Image.open(sheet_path).convert("RGBA")
    cell_w = sheet.width // 5
    cells = []
    for i in range(5):
        cell = chroma_key(sheet.crop((i * cell_w, 0, (i + 1) * cell_w, sheet.height)))
        cells.append(cell.crop(content_bbox(cell)))
    scale = 96 / cells[0].height
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
    work = args.workdir / order["id"]
    work.mkdir(parents=True, exist_ok=True)

    ledger = load_ledger()
    master_meta = ledger["masters"].get(args.master)
    if master_meta is None:
        raise SystemExit(
            f"no master registered for {args.master} — run replace_lane.py "
            f"register first (available: {sorted(ledger['masters'])})"
        )
    period = master_meta["loop"]["period"]
    head_bob_gain, head_bob_phase = bob_profile(order, master_meta)
    master = fetch_r2(master_meta["masterSha256"], work / "master.mp4")
    stand_raw = stand_cell_of_sheet(order, order_path, work / "stand_raw.png")

    if args.mode == "extract":
        frames_dir = work / "frames"
        frame_paths = extract_frames(master, frames_dir)
        assert_green_background(frame_paths)
    else:
        frames_dir = replace_frames(
            order, master, master_meta, stand_raw, work, args.budget
        )

    # Carry sheets stride gently with same-sign contacts by spec (the
    # run_lint rule) — the leg-phase opposition gate only applies to swing
    # walks. Every other gate (junction included) applies to both.
    selected = scan_clip(
        stand_raw,
        frames_dir,
        pinned_contact=args.contact,
        period=period,
        skip_head_seconds=0,
        expect_leg_phase=not order.get("handLayer"),
        head_bob_gain=head_bob_gain,
        head_bob_phase=head_bob_phase,
    )
    chosen = {pose: int(paths[0].stem.split("_")[1]) for pose, paths in selected.items()}
    print(f"cells: {chosen}")

    sheet_path = resolve_asset_path(order_path.parent, order["sheet"], ASSET_ROOT)
    compose_walk_sheet(
        stand_raw,
        selected,
        sheet_path,
        head_bob_gain=head_bob_gain,
        head_bob_phase=head_bob_phase,
    )
    print(f"wrote {sheet_path}")

    # Provenance into the order (the danceMaster rule: the ledger sha is
    # recorded so a silently different master cannot re-anchor the cells).
    order["walkMaster"] = args.master
    order["walkMasterSha256"] = master_meta["masterSha256"]
    order["walkLane"] = {
        "mode": args.mode,
        "cells": chosen,
        "headBobGain": head_bob_gain,
        "headBobPhase": head_bob_phase,
    }
    order_path.write_text(json.dumps(order, ensure_ascii=False, indent=2) + "\n")
    subprocess.run(
        ["pnpm", "exec", "biome", "format", "--write", str(order_path)], check=True
    )

    # Verdict material: master cells vs composed cells + the 96px loop.
    cells = sheet_cells_96(sheet_path)
    master_cells = []
    for pose in POSES:
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
        "headBobGain": head_bob_gain,
        "headBobPhase": head_bob_phase,
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
    produce.add_argument("--workdir", type=Path, default=Path("/tmp/kaede-walk-lane"))
    produce.add_argument("--budget", type=float, default=0.5,
                         help="USD stop for replace mode")
    args = parser.parse_args()
    if args.command == "produce":
        cmd_produce(args)


if __name__ == "__main__":
    main()
