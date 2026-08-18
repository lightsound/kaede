#!/usr/bin/env python3
"""Factory v2 §7 残タスク 2 spike: God Mode AI bench (docs/factory-v2-plan.md
— owner-approved 2026-08-16. The one-point gate: does a deformation-based
walk beat the adopted video-refinement master on cuteness?).

Two lanes were ordered; only one is API-reachable (measured 2026-08-16):

- Sprite-generator lane (THIS TOOL): REST at
  https://www.godmodeai.co/api/generation-api/v1 with the gmd_ token
  (Secrets GODMODE_API_TOKEN). Flow per the official skill: upload file →
  POST /sprite (202 + request_id) → poll status → fetch result
  (generation_url video + sprite_sheet_url). Background removal rides the
  same 3-step flow under /bg-removal. 1 credit = 1 sprite generation,
  bg-removal flat 1 credit (plans page + skill doc).
- Spine-generator lane (BLOCKED — `probe-spine` records the evidence):
  the web app drives it through the Next.js proxy /api/spine-pipeline/*,
  which authenticates the *browser session* (Supabase cookie / session
  JWT). The gmd_ API token gets 401 on every spine route, the public REST
  surface has no spine paths (405-scan: only /sprite, /bg-removal,
  /files/file/local, /actions/catalog, /models), and the official MCP
  exposes no spine tools. Per the task discipline (401/402 → immediate
  stop + owner report), that lane stops here.

Money mechanics follow the spike_pixellab.py precedent: every paid call is
persisted in <workdir>/state.json under its key the moment the submit
returns, so re-runs poll the same request instead of re-billing; a
--budget-credits stop guards every submission. One deviation is forced by
the provider: God Mode has NO balance API (the dashboard reads credits via
the browser-session Supabase client), so the PixelLab-style balance
reconciliation is impossible — credits are metered locally from the
documented per-call prices and the owner's dashboard is the only
authoritative counter. 401/402/403 and FAILED("Insufficient credits") are
hard stops: report to the owner, never route around.

Usage:
    export GODMODE_API_TOKEN=gmd_... CLOUDFLARE_API_TOKEN=...
    python3 scripts/factory/spike_godmode.py <workdir> prepare
    python3 scripts/factory/spike_godmode.py <workdir> sprite \
        --key walk_t1 --image identity_godmode.png \
        --action sidescrolling_walking_looping [--seed 1234] \
        [--positive-prompt ...] [--auto-repose]
    python3 scripts/factory/spike_godmode.py <workdir> bgremove \
        --key bg_walk_t1 --source walk_t1
    python3 scripts/factory/spike_godmode.py <workdir> probe-spine
    python3 scripts/factory/spike_godmode.py <workdir> analyze
    python3 scripts/factory/spike_godmode.py <workdir> material
    python3 scripts/factory/spike_godmode.py <workdir> upload-r2
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
from pathlib import Path

import numpy as np
import requests
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

from factory.art_lint import check_palette_drift  # noqa: E402
from factory.compose_sheet import chroma_key_greenwear, content_bbox  # noqa: E402
from factory.loop_scan import best_loop_start, mask_iou  # noqa: E402
from factory.spike_r2v_bench import judgment_sheet  # noqa: E402
from factory.verdict_material import loop_video, montage_rows, scaled  # noqa: E402
from factory.video import extract_frames, probe, run_quiet  # noqa: E402
from r2_originals import get_object, put_object  # noqa: E402

BASE = "https://www.godmodeai.co/api/generation-api/v1"
SPINE_PROXY = "https://www.godmodeai.co/api/spine-pipeline"
POLL_SECONDS = 5
POLL_TIMEOUT_SECONDS = 20 * 60
# Tier-1 rate limit is 6 RPM — a 429 waits out the window instead of dying.
RATE_LIMIT_WAIT_SECONDS = 15
RATE_LIMIT_MAX_RETRIES = 10

# Documented per-call prices (plans page 2026-08-16: "1 credit = 1 sprite
# generation"; the skill doc: bg-removal "Flat 1 credit"). There is no
# balance API to reconcile against — see the module doc.
SPRITE_CREDITS = 1.0
BGREMOVAL_CREDITS = 1.0
DEFAULT_BUDGET_CREDITS = 6.0
# The owner bought the minimum 20-credit pack — an absolute ceiling no
# --budget-credits value may exceed.
CREDIT_PACK_CEILING = 20.0

# Identity inputs are pinned by content address (運転知見 32: the R2
# original stand cell is the identity authority; the SeedVR2 4x upscale is
# the adopted walk master's identity preprocessing — 運転知見 33).
IDENTITY_SHEET_SHA256 = (
    "6cceff101abf66034f89ad98facf725300417347f623aad0bf084f89bd123f12"
)
IDENTITY_SHEET_COLS = 5
UPSCALED_IDENTITY_SHA256 = (
    "c7b3f9049161e4acbfb09bf3d43c92b295d7ee7148922b25c39f0b66b179ae0b"
)
# God Mode's own input guidance: full body, transparent PNG, ~700-1024px.
GODMODE_INPUT_MAX_SIDE = 1024

MASTER_TAKES = ROOT / "scripts" / "factory" / "master_takes.json"
COMMITTED_AVATAR = ROOT / "packages" / "client" / "src" / "game.package" / "avatar"
JUDGMENT_FONT = "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc"
PHASE_SAMPLES = 8


def token() -> str:
    key = os.environ.get("GODMODE_API_TOKEN")
    if not key:
        raise SystemExit("GODMODE_API_TOKEN is not set")
    return key


def api(method: str, path: str, *, payload: dict | None = None,
        files: dict | None = None) -> dict:
    for attempt in range(RATE_LIMIT_MAX_RETRIES):
        response = requests.request(
            method,
            f"{BASE}{path}",
            headers={"Authorization": f"Bearer {token()}"},
            json=payload,
            files=files,
            timeout=180,
        )
        if response.status_code == 429:
            print(f"  429 rate-limited — waiting {RATE_LIMIT_WAIT_SECONDS}s "
                  f"({attempt + 1}/{RATE_LIMIT_MAX_RETRIES})", flush=True)
            time.sleep(RATE_LIMIT_WAIT_SECONDS)
            continue
        if response.status_code in (401, 402, 403):
            # Task rule: auth/payment rejections stop the bench — the charge
            # decision goes back to the owner, no workaround is attempted.
            raise SystemExit(
                f"God Mode {method} {path} -> HTTP {response.status_code} "
                f"{response.text[:600]}\n"
                "STOP: report to the owner (401/402 discipline — 運転知見 30)."
            )
        if response.status_code not in (200, 201, 202):
            raise SystemExit(
                f"God Mode {method} {path} failed: HTTP {response.status_code} "
                f"{response.text[:800]}"
            )
        return response.json()
    raise SystemExit(f"God Mode {method} {path}: still 429 after "
                     f"{RATE_LIMIT_MAX_RETRIES} waits — stopping")


def digest_of(*parts: bytes | str) -> str:
    h = hashlib.sha256()
    for part in parts:
        h.update(part if isinstance(part, bytes) else part.encode())
    return h.hexdigest()[:12]


class Spike:
    def __init__(self, work: Path, budget_credits: float) -> None:
        self.work = work
        self.budget_credits = min(budget_credits, CREDIT_PACK_CEILING)
        self.state_path = work / "state.json"
        self.state: dict = (
            json.loads(self.state_path.read_text())
            if self.state_path.exists()
            else {"spent_credits": 0.0}
        )

    def save(self) -> None:
        self.state_path.write_text(json.dumps(self.state, indent=1))

    def charge(self, credits: float) -> None:
        if self.state["spent_credits"] + credits > self.budget_credits:
            raise SystemExit(
                f"credit budget stop: {self.state['spent_credits']:g} spent "
                f"+ {credits:g} would exceed --budget-credits "
                f"{self.budget_credits:g} — not submitting"
            )

    def upload(self, path: Path) -> str:
        """Free file hosting — cached by content digest."""
        uploads = self.state.setdefault("uploads", {})
        digest = digest_of(path.read_bytes())
        if digest not in uploads:
            result = api(
                "POST", "/files/file/local",
                files={"file_upload": (path.name, path.read_bytes(), "image/png")},
            )
            uploads[digest] = result["url"]
            self.save()
            print(f"  uploaded {path.name} -> {uploads[digest]}")
        return uploads[digest]

    def submit(self, key: str, path: str, payload: dict, credits: float) -> dict:
        """Persist the paid POST the moment it returns (crash-safe: a re-run
        polls the recorded request instead of paying again)."""
        submits = self.state.setdefault("submits", {})
        if key not in submits:
            self.charge(credits)
            submits[key] = api("POST", path, payload=payload)
            # The billed recipe (minus the throwaway upload URL) rides the
            # state file so the judgment sheet can burn it in later.
            recipe = {k: v for k, v in payload.items() if k != "image_url"}
            self.state.setdefault("recipes", {})[key] = recipe
            self.state["spent_credits"] += credits
            self.save()
            print(f"[{key}] submitted — spent (metered) "
                  f"{self.state['spent_credits']:g}/{self.budget_credits:g} cr")
        return submits[key]

    def poll(self, key: str, kind: str) -> dict:
        """kind: 'sprite' | 'bg-removal'."""
        results = self.state.setdefault("results", {})
        if key in results:
            return results[key]
        request_id = self.state["submits"][key]["request_id"]
        deadline = time.time() + POLL_TIMEOUT_SECONDS
        while True:
            status = api("GET", f"/{kind}/requests/{request_id}/status")
            state = status.get("status")
            if state == "COMPLETED":
                result = api("GET", f"/{kind}/requests/{request_id}")
                results[key] = result
                self.save()
                return result
            if state == "FAILED":
                message = status.get("error_message") or json.dumps(status)[:400]
                if "insufficient credits" in message.lower():
                    raise SystemExit(
                        f"[{key}] FAILED: {message}\n"
                        "STOP: credits exhausted — report to the owner "
                        "(402 discipline)."
                    )
                raise SystemExit(f"[{key}] FAILED: {message}")
            if time.time() > deadline:
                raise SystemExit(
                    f"[{key}] still {state} after {POLL_TIMEOUT_SECONDS}s — "
                    "re-run the same command to resume polling (no re-bill)"
                )
            print(f"  [{key}] {state}", flush=True)
            time.sleep(POLL_SECONDS)

    def download(self, url: str, dest: Path) -> Path:
        if not dest.exists():
            response = requests.get(url, timeout=300)
            response.raise_for_status()
            dest.write_bytes(response.content)
            print(f"  saved {dest} ({len(response.content)} bytes)")
        return dest


# ---------------------------------------------------------------- prepare


def cmd_prepare(spike: Spike, _args: argparse.Namespace) -> None:
    work = spike.work
    # Ground-truth identity cell: the stand cell cut from the R2 ORIGINAL
    # sheet (the spike_r2v_bench prepare precedent) — the palette anchor and
    # judgment-sheet row 1.
    sheet_path = work / "identity_sheet_original.png"
    if not sheet_path.exists():
        sheet_path.write_bytes(get_object(IDENTITY_SHEET_SHA256))
    sheet = Image.open(sheet_path).convert("RGBA")
    stand_canvas = sheet.crop((0, 0, sheet.width // IDENTITY_SHEET_COLS, sheet.height))
    cell = chroma_key_greenwear(stand_canvas)
    cell = cell.crop(content_bbox(cell))
    cell.save(work / "identity_cell.png")

    # God Mode input: the SeedVR2 4x identity (the adopted walk master's
    # identity — high resolution favors a tool that cuts pieces from the
    # artwork), made transparent by mapping the original cell's alpha onto
    # the upscaled square (the upscale is geometry-preserving; the square
    # was built by pasting the cell at a known offset, so the alpha maps
    # back deterministically).
    up_path = work / "identity_upscaled_square.png"
    if not up_path.exists():
        up_path.write_bytes(get_object(UPSCALED_IDENTITY_SHA256))
    upscaled = Image.open(up_path).convert("RGB")
    side = max(cell.size)  # the 400px square the upscale was built from
    scale = upscaled.width // side
    alpha_canvas = Image.new("L", (side * scale, side * scale), 0)
    cell_alpha = cell.getchannel("A").resize(
        (cell.width * scale, cell.height * scale), Image.LANCZOS
    )
    offset = ((side - cell.width) // 2 * scale, (side - cell.height) * scale)
    alpha_canvas.paste(cell_alpha, offset)
    transparent = upscaled.convert("RGBA")
    transparent.putalpha(alpha_canvas)
    transparent = transparent.crop(content_bbox(transparent))
    shrink = min(1.0, GODMODE_INPUT_MAX_SIDE / max(transparent.size))
    if shrink < 1.0:
        transparent = scaled(transparent, shrink)
    input_path = work / "identity_godmode.png"
    transparent.save(input_path)

    manifest = {
        "identityCell": {"file": "identity_cell.png", "size": cell.size,
                         "sheetSha256": IDENTITY_SHEET_SHA256},
        "godmodeInput": {"file": input_path.name, "size": transparent.size,
                         "upscaledSha256": UPSCALED_IDENTITY_SHA256},
    }
    (work / "inputs.json").write_text(json.dumps(manifest, indent=1) + "\n")
    zoom = cell.resize((cell.width * 2, cell.height * 2), Image.NEAREST)
    montage_rows([[cell, zoom], [transparent]], work / "identity_preflight.png")
    print(f"prepared: cell {cell.size}, God Mode input {transparent.size}")


# ------------------------------------------------------------------ lanes


def cmd_sprite(spike: Spike, args: argparse.Namespace) -> None:
    image_path = spike.work / args.image
    payload: dict = {
        "image_url": spike.upload(image_path),
        "action_id": args.action,
        "view_type": args.view,
    }
    if args.seed is not None:
        payload["seed"] = args.seed
    if args.positive_prompt:
        payload["positive_prompt"] = args.positive_prompt
    if args.auto_repose:
        payload["auto_repose"] = True
    spike.submit(args.key, "/sprite", payload, SPRITE_CREDITS)
    result = spike.poll(args.key, "sprite")
    generation_url = result["generation_url"]
    suffix = Path(generation_url.split("?")[0]).suffix or ".mp4"
    spike.download(generation_url, spike.work / f"{args.key}{suffix}")
    if result.get("sprite_sheet_url"):
        spike.download(result["sprite_sheet_url"], spike.work / f"{args.key}_sheet.png")
    if result.get("auto_repose_url"):
        spike.download(result["auto_repose_url"], spike.work / f"{args.key}_repose.png")
    print(f"[{args.key}] COMPLETED")


def cmd_bgremove(spike: Spike, args: argparse.Namespace) -> None:
    source = spike.state.get("results", {}).get(args.source)
    if not source or not source.get("sprite_sheet_url"):
        raise SystemExit(f"no sprite result for --source {args.source!r}")
    payload: dict = {"image_url": source["sprite_sheet_url"]}
    if args.model:
        payload["model"] = args.model
    spike.submit(args.key, "/bg-removal", payload, BGREMOVAL_CREDITS)
    result = spike.poll(args.key, "bg-removal")
    spike.download(result["clean_sprite_sheet_url"], spike.work / f"{args.key}_clean.png")
    if result.get("bbox_overlay_sprite_sheet_url"):
        spike.download(result["bbox_overlay_sprite_sheet_url"],
                       spike.work / f"{args.key}_bbox.png")
    if result.get("preview_url"):
        preview = result["preview_url"]
        suffix = Path(preview.split("?")[0]).suffix or ".mp4"
        spike.download(preview, spike.work / f"{args.key}_preview{suffix}")
    (spike.work / f"{args.key}_boxes.json").write_text(
        json.dumps(result.get("bounding_boxes", []), indent=1) + "\n"
    )
    print(f"[{args.key}] COMPLETED — {result.get('total_frames')} frames")


def cmd_probe_spine(spike: Spike, _args: argparse.Namespace) -> None:
    """Free: record the spine lane's auth wall as reproducible evidence."""
    evidence = {}
    for path in ("health", "jobs/probe", "retarget/animations"):
        response = requests.get(
            f"{SPINE_PROXY}/{path}",
            headers={"Authorization": f"Bearer {token()}"},
            timeout=60,
        )
        evidence[path] = {"status": response.status_code,
                          "body": response.text[:300]}
        print(f"GET /api/spine-pipeline/{path} -> {response.status_code} "
              f"{response.text[:120]}")
    (spike.work / "spine_probe.json").write_text(json.dumps(evidence, indent=1) + "\n")


# ---------------------------------------------------------------- analyze


def background_silhouettes(frame_paths: list[Path]) -> list[np.ndarray]:
    """Silhouette masks for solid-background clips: the background color is
    the median of the border pixels, the silhouette is everything farther
    than a fixed distance (God Mode videos are not chroma-keyed green, so
    the loop_scan alpha silhouette does not apply)."""
    masks = []
    for path in frame_paths:
        rgb = np.asarray(Image.open(path).convert("RGB")).astype(int)
        border = np.concatenate([rgb[0], rgb[-1], rgb[:, 0], rgb[:, -1]])
        background = np.median(border, axis=0)
        distance = np.abs(rgb - background).sum(axis=2)
        image = Image.fromarray((distance > 60).astype(np.uint8) * 255)
        height = max(1, round(image.height * 160 / image.width))
        small = image.resize((160, height), Image.BILINEAR)
        masks.append(np.asarray(small) >= 128)
    return masks


def rgb_wrap_difference(frame_paths: list[Path], start: int, period: int) -> float:
    a = np.asarray(Image.open(frame_paths[start]).convert("RGB")).astype(int)
    b = np.asarray(Image.open(frame_paths[start + period]).convert("RGB")).astype(int)
    return float(np.abs(a - b).mean())


def refine_gait_period(frame_paths: list[Path], loop: dict) -> dict:
    """Half-cycle correction (運転知見 22's 2D analogue): a 3/4-view chibi's
    mirrored steps are silhouette-identical, so the IoU scan can lock onto
    the HALF gait cycle. Full-resolution RGB tells the steps apart (front
    vs back leg shading): when the wrap at 2x the silhouette period matches
    markedly better in RGB, the gait period is the double (measured on
    walk_t1: P=6 diff 8.96 vs 2P=12 diff 5.63)."""
    start, period = loop["start"], loop["period"]
    gait = period
    # best_loop_start legitimately returns start == len - 2 * period, which
    # puts the 2P wrap one frame past the clip; anchor the comparison earlier
    # so the check always fits (measure_loop guarantees len >= 2P + 1).
    anchor = min(start, len(frame_paths) - 1 - 2 * period)
    if anchor >= 0:
        at_p = rgb_wrap_difference(frame_paths, anchor, period)
        at_2p = rgb_wrap_difference(frame_paths, anchor, 2 * period)
        if at_2p < at_p * 0.8:
            gait = 2 * period
    return {**loop, "gaitPeriod": gait}


def measure_loop(masks: list[np.ndarray]) -> dict | None:
    """Best (start, period) over the full plausible range — God Mode clips
    carry no reference period, so the search is unconstrained."""
    hi = (len(masks) - 1) // 2
    if hi < 6:
        return None
    best: tuple[float, int, int] | None = None
    for period in range(6, hi + 1):
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


def sheet_cells(spike: Spike, bg_key: str) -> list[Image.Image]:
    """Transparent per-frame cells from a bg-removal result.

    Sliced on the 4-column video-frame grid, NOT on the returned
    bounding_boxes: the boxes describe a repacked tight layout whose x/y do
    not land on the clean sheet's actual cells (measured 2026-08-16 — cell
    (260,0,244x448) is 61% opaque but the box for frame 1 points at empty
    canvas). The grid is authoritative because the sheet is column-major
    4-wide by construction.
    """
    boxes = json.loads((spike.work / f"{bg_key}_boxes.json").read_text())
    sheet = Image.open(spike.work / f"{bg_key}_clean.png").convert("RGBA")
    columns = 4
    rows = -(-len(boxes) // columns)
    cell_w, cell_h = sheet.width // columns, sheet.height // rows
    cells = []
    for index in range(len(boxes)):
        row, col = divmod(index, columns)
        cell = sheet.crop((col * cell_w, row * cell_h,
                           (col + 1) * cell_w, (row + 1) * cell_h))
        cells.append(cell.crop(content_bbox(cell)))
    return cells


def sprite_takes(spike: Spike) -> list[str]:
    results = spike.state.get("results", {})
    return [key for key in results if not key.startswith("bg_")]


def cmd_analyze(spike: Spike, _args: argparse.Namespace) -> None:
    work = spike.work
    report: dict = {"spentCreditsMetered": spike.state["spent_credits"],
                    "balanceApi": "none (dashboard-only — see module doc)",
                    "takes": {}}
    identity_cell = Image.open(work / "identity_cell.png").convert("RGBA")
    for key in sprite_takes(spike):
        videos = sorted(work.glob(f"{key}.*"))
        video = next((v for v in videos if v.suffix in (".mp4", ".webm", ".webp")), None)
        if video is None:
            continue
        info = probe(video)
        frame_paths = extract_frames(video, work / f"frames_{key}")
        masks = background_silhouettes(frame_paths)
        loop = measure_loop(masks)
        if loop:
            loop = refine_gait_period(frame_paths, loop)
        entry: dict = {
            "file": video.name,
            "frames": info.frames,
            "fps": round(info.fps, 2),
            "seconds": round(info.duration, 2),
            "loop": loop,
        }
        if loop:
            entry["cycleSeconds"] = round(loop["gaitPeriod"] / info.fps, 3)
        bg_key = f"bg_{key}"
        if (work / f"{bg_key}_boxes.json").exists():
            cells = sheet_cells(spike, bg_key)
            mid = cells[len(cells) // 2]
            entry["identityPaletteDrift"] = check_palette_drift(
                identity_cell, mid.crop(content_bbox(mid))
            )
            entry["sheetFrames"] = len(cells)
        report["takes"][key] = entry
        print(f"{key}: {json.dumps(entry)}")
    (work / "bench-report.json").write_text(json.dumps(report, indent=1) + "\n")


# --------------------------------------------------------------- material


def master_cells(work: Path, n: int = PHASE_SAMPLES) -> list[Image.Image]:
    """Phase cells of the adopted walk master (ledger walk/boy) — the
    comparison baseline the gate names."""
    ledger = json.loads(MASTER_TAKES.read_text())["masters"]["walk/boy"]
    path = work / "master_walk.mp4"
    if not path.exists():
        path.write_bytes(get_object(ledger["masterSha256"]))
    frame_paths = extract_frames(path, work / "frames_master_walk")
    start, period = ledger["loop"]["start"], ledger["loop"]["period"]
    cells = []
    for i in range(n):
        index = min(start + round(i * period / n), len(frame_paths) - 1)
        keyed = chroma_key_greenwear(Image.open(frame_paths[index]))
        cells.append(keyed.crop(content_bbox(keyed)))
    return cells


def take_loop(spike: Spike, key: str) -> dict:
    entry = json.loads(
        (spike.work / "bench-report.json").read_text()
    )["takes"][key]
    loop = entry.get("loop")
    if not loop:
        return {"start": 0, "gaitPeriod": entry["frames"] - 1}
    return loop


def take_cells(spike: Spike, key: str, n: int = PHASE_SAMPLES) -> list[Image.Image]:
    """Phase cells over the measured GAIT cycle (not the silhouette period —
    sampling the half cycle would fabricate a one-leg skip), preferring
    bg-removed sheet cells (true transparency; sheet frames map 1:1 onto
    video frames) over background-thresholded video frames."""
    work = spike.work
    loop = take_loop(spike, key)
    start, period = loop["start"], loop["gaitPeriod"]
    bg_key = f"bg_{key}"
    if (work / f"{bg_key}_boxes.json").exists():
        cells = sheet_cells(spike, bg_key)
        return [cells[min(start + round(i * period / n), len(cells) - 1)]
                for i in range(n)]
    video = next((v for v in sorted(work.glob(f"{key}.*"))
                  if v.suffix in (".mp4", ".webm", ".webp")), None)
    frame_paths = extract_frames(video, work / f"frames_{key}")
    cells = []
    for i in range(n):
        index = min(start + round(i * period / n), len(frame_paths) - 1)
        rgb = np.asarray(Image.open(frame_paths[index]).convert("RGB")).astype(int)
        border = np.concatenate([rgb[0], rgb[-1], rgb[:, 0], rgb[:, -1]])
        background = np.median(border, axis=0)
        alpha = (np.abs(rgb - background).sum(axis=2) > 60).astype(np.uint8) * 255
        cell = Image.open(frame_paths[index]).convert("RGBA")
        cell.putalpha(Image.fromarray(alpha))
        cells.append(cell.crop(content_bbox(cell)))
    return cells


def committed_cells() -> list[Image.Image]:
    names = ["walk-a.png", "walk-b.png", "walk-c.png", "walk-d.png"]
    return [Image.open(COMMITTED_AVATAR / name).convert("RGBA") for name in names]


def stack_loop_videos(videos: list[Path], labels: list[str], out: Path) -> None:
    """Side-by-side loop video with Japanese labels burned in (運転知見 34
    — wqy-microhei; DroidSansFallback tofus Latin)."""
    existing = [(v, l) for v, l in zip(videos, labels) if v.exists()]
    if len(existing) < 2:
        return
    cmd = ["ffmpeg", "-y", "-loglevel", "error"]
    for video, _ in existing:
        cmd += ["-stream_loop", "-1", "-t", "6", "-i", str(video)]

    def escape(label: str) -> str:
        # drawtext re-parses its text value, so option separators inside the
        # quoted label still need escaping (an unescaped ':' tofu'd the whole
        # label — measured 2026-08-16).
        return label.replace("\\", "\\\\").replace(":", "\\:").replace("'", "")

    parts = [
        f"[{i}:v]scale=-2:420,drawtext=fontfile={JUDGMENT_FONT}:"
        f"text='{escape(label)}':x=8:y=8:fontsize=22:fontcolor=black:box=1:"
        f"boxcolor=white@0.7[v{i}]"
        for i, (_, label) in enumerate(existing)
    ]
    chain = "".join(f"[v{i}]" for i in range(len(existing)))
    filtergraph = ";".join(parts) + f";{chain}hstack=inputs={len(existing)}[out]"
    cmd += ["-filter_complex", filtergraph, "-map", "[out]",
            "-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p", str(out)]
    run_quiet(cmd)
    print(f"wrote {out.name}")


def cmd_material(spike: Spike, args: argparse.Namespace) -> None:
    work = spike.work
    identity = Image.open(work / "identity_cell.png").convert("RGBA")
    report = json.loads((work / "bench-report.json").read_text())
    rows: list[tuple[str, str, list[Image.Image]]] = [
        ("1. 元画像(正解) — boy stand セル", "R2 原本 sheet-original の第 1 セル "
         "218×400(6cceff…)。God Mode 入力はこの SeedVR2 4x 透過版 1024px",
         [identity]),
        ("2. committed walk セル(現行出荷)", "packages/client avatar walk-a..d "
         "192px — 承認済み出荷セル", committed_cells()),
        ("3. 採用マスター walk/boy(比較基準)", "seedance 2.5 720p × 立ちセル "
         "SeedVR2 4x identity(ea621ba6…・loop 0.988/0.990・$2.45)— "
         "2026-08-16 オーナー採用", master_cells(work)),
    ]
    index = 4
    for key, entry in report.get("takes", {}).items():
        loop = entry.get("loop") or {}
        drift = entry.get("identityPaletteDrift")
        drift_note = (f"・パレットドリフト {len(drift)} 件"
                      if isinstance(drift, list) else "")
        submitted = spike.state.get("recipes", {}).get(key, {})
        prompt_note = ("・positive_prompt あり(両手前保持を指示)"
                       if submitted.get("positive_prompt") else "")
        bg_note = ("+bg-removal 1cr"
                   if (work / f"bg_{key}_boxes.json").exists() else "")
        recipe = (
            f"God Mode sprite API・action={submitted.get('action_id')}・"
            f"seed={submitted.get('seed')}{prompt_note}・"
            f"{entry['file']} {entry['frames']}f/{entry['fps']}fps・"
            f"loop {loop.get('loopMean')}/{loop.get('closure')}・"
            f"歩行周期 {entry.get('cycleSeconds')}s・実測 {SPRITE_CREDITS:g}cr{bg_note}"
            f"{drift_note}"
        )
        rows.append((f"{index}. God Mode {key}", recipe, take_cells(spike, key)))
        index += 1
    judgment_sheet(rows, work / "hantei_godmode_walk.png")

    # Side-by-side loop: adopted master vs each God Mode take (100ms/cell,
    # the PixelLab-precedent judging speed).
    master = master_cells(work)
    loop_video(master, work / "loop_master.mp4")
    videos = [work / "loop_master.mp4"]
    # Short labels only — long text overflows a 100ms-loop column and
    # collides with its neighbor (運転知見 34: no cut-off text; the full
    # recipes live on the judgment sheet).
    labels = ["基準: 採用マスター"]
    for key in report.get("takes", {}):
        cells = take_cells(spike, key)
        loop_video(cells, work / f"loop_{key}.mp4")
        videos.append(work / f"loop_{key}.mp4")
        labels.append(f"God Mode {key}")
    stack_loop_videos(videos, labels, work / "loops_side_by_side_walk.mp4")


# ----------------------------------------------------------------- upload


def cmd_upload_r2(spike: Spike, _args: argparse.Namespace) -> None:
    work = spike.work
    hashes = {}
    patterns = ["*_t*.mp4", "*_t*.webm", "*_t*.webp", "*_sheet.png",
                "*_clean.png", "hantei_godmode_walk.png",
                "loops_side_by_side_walk.mp4"]
    seen = set()
    for pattern in patterns:
        for path in sorted(work.glob(pattern)):
            if (path.name in seen
                    or path.stem.startswith(("loop_", "frames_"))
                    or path.stem.endswith("_preview")):
                continue
            seen.add(path.name)
            hashes[path.name] = put_object(path.read_bytes())
            print(f"{path.name}: {hashes[path.name]}")
    (work / "r2-hashes.json").write_text(json.dumps(hashes, indent=1) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("workdir", type=Path)
    parser.add_argument("--budget-credits", type=float,
                        default=DEFAULT_BUDGET_CREDITS)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("prepare")
    sprite = sub.add_parser("sprite")
    sprite.add_argument("--key", required=True)
    sprite.add_argument("--image", required=True)
    sprite.add_argument("--action", required=True)
    sprite.add_argument("--view", default="side-scrolling")
    sprite.add_argument("--seed", type=int, default=None)
    sprite.add_argument("--positive-prompt", default=None)
    sprite.add_argument("--auto-repose", action="store_true")
    bgremove = sub.add_parser("bgremove")
    bgremove.add_argument("--key", required=True)
    bgremove.add_argument("--source", required=True)
    bgremove.add_argument("--model", default=None)
    sub.add_parser("probe-spine")
    sub.add_parser("analyze")
    sub.add_parser("material")
    sub.add_parser("upload-r2")

    args = parser.parse_args()
    args.workdir.mkdir(parents=True, exist_ok=True)
    spike = Spike(args.workdir, args.budget_credits)
    commands = {
        "prepare": cmd_prepare,
        "sprite": cmd_sprite,
        "bgremove": cmd_bgremove,
        "probe-spine": cmd_probe_spine,
        "analyze": cmd_analyze,
        "material": cmd_material,
        "upload-r2": cmd_upload_r2,
    }
    commands[args.command](spike, args)


if __name__ == "__main__":
    main()
