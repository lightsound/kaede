#!/usr/bin/env python3
"""Factory v2 step 5 spike: PixelLab style-fidelity bench (the wildcard row of
docs/factory-v2-plan.md §5/§6-5 — does PixelLab's pixel-art house style bend
to kaede's soft chibi look? PR #97/#98 are the precedent for the verdict
material, spike_meshy_rig.py for the tool design).

Kept as the experiment's reproduction tool. Not part of the production
factory line.

Pipeline (PixelLab API v2 — base https://api.pixellab.ai/v2, Bearer auth):
  balance    GET  /balance                    (free — auth + trial check)
  pixelart   POST /image-to-pixelart          (stage 1: conversion probe)
  bitforge   POST /create-image-bitforge      (stage 2: style-image generation)
  style      POST /generate-with-style-v2     (stage 2b, Pro: style reference)
  character  POST /create-character-v3        (stage 3: register character)
  animate    POST /animate-character          (stage 3: template walk)
  montage    (free, local) side-by-side verdict rows vs committed cells

Every paid call is recorded in <workdir>/state.json under its --key so
re-runs never re-bill (the spike_meshy_rig step/submit pattern). Spend is
metered from each response's `usage` object (usd or subscription
generations) and cross-checked against GET /balance; the run aborts before
any call that would exceed --budget-usd / --budget-generations. The trial
account has no USD credits, so a 402 (or 401/403) is a hard stop: the
script fails loudly and the charge decision goes back to the owner — no
paid workaround is attempted (task rule).

Usage:
    export PIXELLAB_API_TOKEN=...
    python3 scripts/factory/spike_pixellab.py <workdir> balance
    python3 scripts/factory/spike_pixellab.py <workdir> pixelart \
        --key px_stand --image stand.png --out-width 105 --out-height 192
    python3 scripts/factory/spike_pixellab.py <workdir> bitforge \
        --key bf_boy --description "..." --style-image stand.png \
        --width 105 --height 192
    python3 scripts/factory/spike_pixellab.py <workdir> style \
        --key st_boy --description "..." --style-image stand.png
    python3 scripts/factory/spike_pixellab.py <workdir> character \
        --key ch_boy --description "..." --reference-image a_pose.png
    python3 scripts/factory/spike_pixellab.py <workdir> animate \
        --key an_walk --character-id <id> --template walking-6-frames \
        --directions east
    python3 scripts/factory/spike_pixellab.py <workdir> montage \
        --rows committed=... pixellab=... --out verdict.png
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import sys
import time
import zipfile
from pathlib import Path

import requests
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

BASE = "https://api.pixellab.ai/v2"
POLL_SECONDS = 6
POLL_TIMEOUT_SECONDS = 15 * 60
# Trial accounts hold subscription generations, not USD (40 measured
# 2026-08-15); paid accounts hold USD credits. Both are metered.
DEFAULT_BUDGET_USD = 5.0
DEFAULT_BUDGET_GENERATIONS = 38.0


def token() -> str:
    import os

    key = os.environ.get("PIXELLAB_API_TOKEN")
    if not key:
        raise SystemExit("PIXELLAB_API_TOKEN is not set")
    return key


def api(method: str, path: str, payload: dict | None = None) -> dict:
    response = requests.request(
        method,
        f"{BASE}{path}",
        headers={"Authorization": f"Bearer {token()}"},
        json=payload,
        timeout=180,
    )
    if response.status_code in (401, 402, 403):
        # The hard stop of the task rules: the trial tier rejected the call
        # (auth problem or payment required). Charging is the owner's call —
        # report the estimate, do not route around.
        raise SystemExit(
            f"PixelLab {method} {path} -> HTTP {response.status_code} "
            f"{response.text[:600]}\n"
            "STOP: trial tier rejected the call — report to the owner with a "
            "charge estimate instead of working around (task rule)."
        )
    if response.status_code not in (200, 201, 202):
        raise SystemExit(
            f"PixelLab {method} {path} failed: HTTP {response.status_code} "
            f"{response.text[:800]}"
        )
    return response.json()


def image_b64(path: Path) -> dict:
    return {"type": "base64", "base64": base64.b64encode(path.read_bytes()).decode()}


def save_b64(image: dict, dest: Path) -> Path:
    dest.write_bytes(base64.b64decode(image["base64"]))
    print(f"  saved {dest}")
    return dest


def digest_of(*parts: bytes | str) -> str:
    h = hashlib.sha256()
    for part in parts:
        h.update(part if isinstance(part, bytes) else part.encode())
    return h.hexdigest()[:12]


class Spike:
    def __init__(self, work: Path, budget_usd: float, budget_generations: float) -> None:
        self.work = work
        self.budget_usd = budget_usd
        self.budget_generations = budget_generations
        self.state_path = work / "state.json"
        self.state: dict = (
            json.loads(self.state_path.read_text())
            if self.state_path.exists()
            else {"spent_usd": 0.0, "spent_generations": 0.0}
        )

    def save(self) -> None:
        self.state_path.write_text(json.dumps(self.state, indent=1))

    def check_budget(self) -> None:
        # Trial `usage` objects mix meters (animate jobs report usd while
        # consuming generations — 運転知見 30), so the metered counters are
        # cross-checked against the authoritative GET /balance delta and the
        # larger figure gates the spend.
        balance = api("GET", "/balance")
        usd = float((balance.get("credits") or {}).get("usd") or 0.0)
        generations = float((balance.get("subscription") or {}).get("generations") or 0.0)
        if "balance_start" not in self.state:
            self.state["balance_start"] = {"usd": usd, "generations": generations}
            self.save()
        start = self.state["balance_start"]
        spent_usd = max(self.state["spent_usd"], start["usd"] - usd)
        spent_generations = max(
            self.state["spent_generations"], start["generations"] - generations
        )
        if spent_usd >= self.budget_usd:
            raise SystemExit(
                f"USD budget exhausted: {spent_usd:.4f} >= {self.budget_usd} — stopping"
            )
        if spent_generations >= self.budget_generations:
            raise SystemExit(
                "generation budget exhausted: "
                f"{spent_generations:g} >= {self.budget_generations} — stopping"
            )

    def meter(self, usage: dict | None) -> None:
        if not usage:
            return
        self.state["spent_usd"] += float(usage.get("usd") or 0.0)
        self.state["spent_generations"] += float(usage.get("generations") or 0.0)
        self.save()

    def step(self, key: str, run) -> dict:
        """Run a paid step once; the recorded result survives re-runs."""
        if key in self.state:
            print(f"[{key}] cached")
            return self.state[key]
        self.check_budget()
        self.state[key] = run()
        self.save()
        print(
            f"[{key}] spent so far: ${self.state['spent_usd']:.4f} / "
            f"{self.state['spent_generations']:g} generations"
        )
        return self.state[key]

    def submit(self, key: str, request) -> dict:
        """Persist a paid POST response the moment it returns, so a crash
        during the minutes-long poll resumes the same job instead of paying
        for a new one (the spike_meshy_rig submit pattern)."""
        submits = self.state.setdefault("submits", {})
        if key not in submits:
            submits[key] = request()
            self.save()
            self.meter(submits[key].get("usage"))
        return submits[key]

    def poll_job(self, job_id: str) -> dict:
        deadline = time.time() + POLL_TIMEOUT_SECONDS
        while True:
            data = api("GET", f"/background-jobs/{job_id}")
            status = data["status"]
            if status == "completed":
                metered = self.state.setdefault("metered_jobs", [])
                if job_id not in metered:
                    metered.append(job_id)
                    self.meter(data.get("usage"))
                    self.save()
                return data
            if status == "failed":
                raise SystemExit(f"job {job_id} failed: {json.dumps(data)[:800]}")
            if time.time() > deadline:
                raise SystemExit(f"job {job_id} still {status} after {POLL_TIMEOUT_SECONDS}s")
            print(f"  job {job_id}: {status}", flush=True)
            time.sleep(POLL_SECONDS)


def cmd_balance(_spike: Spike, _args: argparse.Namespace) -> None:
    print(json.dumps(api("GET", "/balance"), indent=1))


def cmd_pixelart(spike: Spike, args: argparse.Namespace) -> None:
    source = Image.open(args.image).convert("RGBA")
    # Input must be 16..1280 per side; upscale small committed cells so the
    # recommended ~1/4 input->output ratio holds, downscale oversized inputs.
    scale = min(1280 / source.width, 1280 / source.height)
    upscale = max(args.out_width * 4 / source.width, args.out_height * 4 / source.height)
    factor = min(scale, max(1.0, upscale))
    sized = source.resize(
        (round(source.width * factor), round(source.height * factor)), Image.LANCZOS
    )
    buffer = io.BytesIO()
    sized.save(buffer, format="PNG")
    key = f"{args.key}_{digest_of(buffer.getvalue(), str(args.out_width), str(args.out_height))}"

    def run() -> dict:
        response = api(
            "POST",
            "/image-to-pixelart",
            {
                "image": {"type": "base64", "base64": base64.b64encode(buffer.getvalue()).decode()},
                "image_size": {"width": sized.width, "height": sized.height},
                "output_size": {"width": args.out_width, "height": args.out_height},
            },
        )
        spike.meter(response.get("usage"))
        save_b64(response["image"], spike.work / f"{args.key}.png")
        return {"usage": response.get("usage")}

    spike.step(key, run)


def cmd_bitforge(spike: Spike, args: argparse.Namespace) -> None:
    style = Path(args.style_image)
    # Fingerprint every input that changes the billed result, so re-running
    # the same --key with e.g. a different --style-strength never reuses a
    # stale cache entry.
    fingerprint = digest_of(
        style.read_bytes(),
        args.description,
        str(args.seed),
        str(args.style_strength),
        str(args.width),
        str(args.height),
    )
    key = f"{args.key}_{fingerprint}"

    def run() -> dict:
        payload = {
            "description": args.description,
            "image_size": {"width": args.width, "height": args.height},
            "style_image": image_b64(style),
            "style_strength": args.style_strength,
            "no_background": True,
            "view": "side",
            "direction": "east",
        }
        if args.seed is not None:
            payload["seed"] = args.seed
        response = api("POST", "/create-image-bitforge", payload)
        spike.meter(response.get("usage"))
        save_b64(response["image"], spike.work / f"{args.key}.png")
        return {"usage": response.get("usage")}

    spike.step(key, run)


def cmd_style(spike: Spike, args: argparse.Namespace) -> None:
    style = Path(args.style_image)
    with Image.open(style) as im:
        width, height = im.size
    key = f"{args.key}_{digest_of(style.read_bytes(), args.description)}"

    def run() -> dict:
        response = spike.submit(
            key,
            lambda: api(
                "POST",
                "/generate-with-style-v2",
                {
                    "style_images": [
                        {"image": image_b64(style), "width": width, "height": height}
                    ],
                    "description": args.description,
                    "style_description": args.style_description,
                    "no_background": True,
                },
            ),
        )
        job = spike.poll_job(response["background_job_id"])
        images = (job.get("last_response") or {}).get("images") or []
        for index, image in enumerate(images):
            save_b64(image, spike.work / f"{args.key}_{index}.png")
        return {"usage": response.get("usage"), "images": len(images)}

    spike.step(key, run)


def cmd_character(spike: Spike, args: argparse.Namespace) -> None:
    reference = Path(args.reference_image)
    key = f"{args.key}_{digest_of(reference.read_bytes(), args.description)}"

    def run() -> dict:
        response = spike.submit(
            key,
            lambda: api(
                "POST",
                "/create-character-v3",
                {
                    "description": args.description,
                    "reference_image": image_b64(reference),
                    "view": args.view,
                    "no_background": True,
                },
            ),
        )
        character_id = response["character_id"]
        print(f"  character {character_id}")
        spike.poll_job(response["background_job_id"])
        return {"usage": response.get("usage"), "character_id": character_id}

    result = spike.step(key, run)
    download_character(spike, result["character_id"], args.key)


def download_character(spike: Spike, character_id: str, prefix: str) -> None:
    """Free re-downloadable artifacts: rotations + all animation frames."""
    body = requests.get(
        f"{BASE}/characters/{character_id}/zip",
        headers={"Authorization": f"Bearer {token()}"},
        timeout=180,
    )
    if body.status_code != 200:
        raise SystemExit(f"character zip failed: HTTP {body.status_code} {body.text[:300]}")
    archive = zipfile.ZipFile(io.BytesIO(body.content))
    out_dir = spike.work / f"{prefix}_character"
    out_dir.mkdir(exist_ok=True)
    for name in archive.namelist():
        if name.endswith("/"):
            continue
        dest = out_dir / name.replace("/", "_")
        dest.write_bytes(archive.read(name))
    print(f"  character zip -> {out_dir} ({len(archive.namelist())} entries)")


def cmd_animate(spike: Spike, args: argparse.Namespace) -> None:
    key = f"{args.key}_{digest_of(args.character_id, args.template, ','.join(args.directions))}"

    def run() -> dict:
        response = spike.submit(
            key,
            lambda: api(
                "POST",
                "/animate-character",
                {
                    "character_id": args.character_id,
                    "mode": "template",
                    "template_animation_id": args.template,
                    "directions": args.directions,
                },
            ),
        )
        job_ids = response.get("background_job_ids") or []
        for job_id in job_ids:
            spike.poll_job(job_id)
        return {"jobs": job_ids}

    spike.step(key, run)
    download_character(spike, args.character_id, args.key)


def cmd_montage(spike: Spike, args: argparse.Namespace) -> None:
    """Side-by-side verdict rows (free, deterministic): each row is
    `label=path,path,...`; cells are ground-aligned and upscaled like
    factory/verdict_material.py so the owner judges at game scale."""
    from PIL import ImageDraw

    rows = []
    for spec in args.rows:
        label, _, paths = spec.partition("=")
        cells = [Image.open(p).convert("RGBA") for p in paths.split(",")]
        rows.append((label, cells))
    scale = args.scale
    pad = 10
    label_h = 16
    height_ref = max(cell.height for _, cells in rows for cell in cells)
    row_w = max(
        sum(cell.width * scale + pad for cell in cells) + pad for _, cells in rows
    )
    row_h = height_ref * scale + pad + label_h
    canvas = Image.new("RGBA", (row_w, row_h * len(rows) + pad), (240, 240, 245, 255))
    draw = ImageDraw.Draw(canvas)
    for row_index, (label, cells) in enumerate(rows):
        top = row_index * row_h + pad + label_h
        draw.text((pad, row_index * row_h + pad), label, fill=(40, 40, 60, 255))
        x = pad
        for cell in cells:
            scaled = cell.resize((cell.width * scale, cell.height * scale), Image.NEAREST)
            # Ground-align: feet on the shared baseline.
            y = top + height_ref * scale - scaled.height
            canvas.alpha_composite(scaled, (x, y))
            x += scaled.width + pad
    out = Path(args.out)
    canvas.save(out)
    print(f"montage -> {out}")


def cmd_loop(spike: Spike, args: argparse.Namespace) -> None:
    """Side-by-side loop video (free, deterministic): each column is
    `label=path,path,...` cycling at 100ms/frame (the gesture runtime's
    DANCE_FRAME_MS precedent); columns of different frame counts loop
    independently so a 4-cell committed cycle rides next to a 6-frame
    PixelLab cycle."""
    from factory.video import run_quiet

    columns = []
    for spec in args.columns:
        label, _, paths = spec.partition("=")
        cells = [Image.open(p).convert("RGBA") for p in paths.split(",")]
        columns.append((label, cells))
    scale = args.scale
    pad = 12
    height_ref = max(cell.height for _, cells in columns for cell in cells)
    col_w = [max(cell.width for cell in cells) * scale + pad for _, cells in columns]
    width = (sum(col_w) + pad + 1) // 2 * 2
    height = (height_ref * scale + 2 * pad + 1) // 2 * 2
    steps = args.seconds * 10  # 100ms per step
    scratch = spike.work / f"{Path(args.out).stem}_frames"
    scratch.mkdir(exist_ok=True)
    for old in scratch.glob("*.png"):
        old.unlink()
    for step in range(steps):
        canvas = Image.new("RGBA", (width, height), (240, 240, 245, 255))
        x = pad
        for index, (_, cells) in enumerate(columns):
            cell = cells[step % len(cells)]
            scaled = cell.resize((cell.width * scale, cell.height * scale), Image.NEAREST)
            canvas.alpha_composite(scaled, (x, height - pad - scaled.height))
            x += col_w[index]
        canvas.convert("RGB").save(scratch / f"loop_{step:04d}.png")
    run_quiet([
        "ffmpeg", "-y", "-loglevel", "error",
        "-framerate", "10",
        "-i", str(scratch / "loop_%04d.png"),
        "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", str(args.out),
    ])
    print(f"loop video -> {args.out}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("workdir", type=Path)
    parser.add_argument("--budget-usd", type=float, default=DEFAULT_BUDGET_USD)
    parser.add_argument("--budget-generations", type=float, default=DEFAULT_BUDGET_GENERATIONS)
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("balance", help="free auth + trial-quota check")

    pixelart = sub.add_parser("pixelart", help="stage 1: image-to-pixelart conversion probe")
    pixelart.add_argument("--key", required=True)
    pixelart.add_argument("--image", type=Path, required=True)
    pixelart.add_argument("--out-width", type=int, required=True)
    pixelart.add_argument("--out-height", type=int, required=True)

    bitforge = sub.add_parser("bitforge", help="stage 2: style-image generation (non-Pro)")
    bitforge.add_argument("--key", required=True)
    bitforge.add_argument("--description", required=True)
    bitforge.add_argument("--style-image", type=Path, required=True)
    bitforge.add_argument("--width", type=int, required=True)
    bitforge.add_argument("--height", type=int, required=True)
    bitforge.add_argument("--style-strength", type=int, default=80)
    bitforge.add_argument("--seed", type=int, default=None)

    style = sub.add_parser("style", help="stage 2b: generate-with-style-v2 (Pro)")
    style.add_argument("--key", required=True)
    style.add_argument("--description", required=True)
    style.add_argument("--style-image", type=Path, required=True)
    style.add_argument("--style-description", default=None)

    character = sub.add_parser("character", help="stage 3: create-character-v3 (reference mode)")
    character.add_argument("--key", required=True)
    character.add_argument("--description", required=True)
    character.add_argument("--reference-image", type=Path, required=True)
    character.add_argument("--view", default="side")

    animate = sub.add_parser("animate", help="stage 3: template walk on a registered character")
    animate.add_argument("--key", required=True)
    animate.add_argument("--character-id", required=True)
    animate.add_argument("--template", default="walking-6-frames")
    animate.add_argument("--directions", nargs="+", default=["east"])

    montage = sub.add_parser("montage", help="free: side-by-side verdict rows")
    montage.add_argument("--rows", nargs="+", required=True, help="label=path,path,...")
    montage.add_argument("--out", required=True)
    montage.add_argument("--scale", type=int, default=3)

    loop = sub.add_parser("loop", help="free: side-by-side loop video")
    loop.add_argument("--columns", nargs="+", required=True, help="label=path,path,...")
    loop.add_argument("--out", required=True)
    loop.add_argument("--scale", type=int, default=2)
    loop.add_argument("--seconds", type=int, default=6)

    args = parser.parse_args()
    args.workdir.mkdir(parents=True, exist_ok=True)
    spike = Spike(args.workdir, args.budget_usd, args.budget_generations)

    commands = {
        "balance": cmd_balance,
        "pixelart": cmd_pixelart,
        "bitforge": cmd_bitforge,
        "style": cmd_style,
        "character": cmd_character,
        "animate": cmd_animate,
        "montage": cmd_montage,
        "loop": cmd_loop,
    }
    commands[args.command](spike, args)


if __name__ == "__main__":
    main()
