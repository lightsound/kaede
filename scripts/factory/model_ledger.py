#!/usr/bin/env python3
"""3D-master ledger for the factory v2 first layer (手順 2 — 3D 正本の台帳化).

One rigged GLB per character family is the 3D 正本 (identity + pose
authority, factory-v2-plan §2); motion GLBs (Meshy catalog presets
retargeted onto that rig) are registered per motion with a machine gate.
The ledger is master_models.json, the master_takes.json precedent applied
to layer 1: registration requirements are enforced here, not by prose.

Registration gates (the 手順 2 合否ゲート):
  1. R2 custody — every GLB is content-addressed in kaede-asset-originals
     and hash-verified on registration. Meshy deletes its own tasks after
     ~3 days (measured 2026-08-14: every 2026-08-10/11 task id 404s), so
     the R2 bytes are the ONLY durable master; new retargets re-rig from
     the stored remesh GLB via the rigging API's `model_url` input.
  2. Owner approval — --approval records where the owner approved.
  3. Bone-signature loop closure (bone_signature.py) — the true full cycle
     is identified in joint space at the mold stage (運転知見 22): relative
     closure, whole-cycle drift, and for gaits the two-step check (L−R
     foot lead flips exactly twice, both feet lead, halves antiphase).
  4. The green reference (bpy yaw45 — spike_tripo_render contract, cycle-
     exact sub-frame sampling, tiled ×3) passes the master-grade silhouette
     loop gates (loop_scan) and is itself stored on R2.

Subcommands:
    register-model   register a family's rigged GLB (+ remesh re-rig source)
    register-motion  gate + render + register one motion GLB for a family
    retarget         mint a new motion GLB: re-rig the family's stored
                     remesh GLB (model_url, 5cr) + retarget one catalog
                     preset (3cr) — Meshy spend is state-persisted and
                     budget-stopped (spike_meshy_rig precedent)

Usage:
    export CLOUDFLARE_API_TOKEN=... MESHY_API_KEY=...
    python3 scripts/factory/model_ledger.py register-model --family boy \
        --rigged <sha256> --remesh <sha256> --provenance ... --approval ...
    python3 scripts/factory/model_ledger.py register-motion --family boy \
        --motion walk --glb <sha256|path> --preset "walking(rig 付属)" \
        --approval ... [--no-gait] [--workdir DIR]
    python3 scripts/factory/model_ledger.py retarget --family girl \
        --preset Texting_Walk_inplace --budget 20 [--workdir DIR]
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import requests
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

from factory import bone_signature, fal_client  # noqa: E402
from factory.loop_scan import find_loop, silhouette_mask  # noqa: E402
from factory.replace_lane import (  # noqa: E402
    SHA256_PATTERN,
    assert_green_background,
    keyed_frames,
)
from factory.spike_meshy_rig import resolve_action_ids  # noqa: E402
from factory.video import extract_frames, run_quiet  # noqa: E402
from r2_originals import get_object, put_object, sha256_of  # noqa: E402

LEDGER_PATH = Path(__file__).resolve().parent / "master_models.json"
DEFAULT_WORKDIR = Path("/tmp/kaede-model-ledger")

REFERENCE_FPS = 24
REFERENCE_TILES = 3
REFERENCE_RESOLUTION = 720
REFERENCE_YAW = 45.0
GREEN = (0, 255, 0)

MESHY_BASE = "https://api.meshy.ai/openapi/v1"
MESHY_POLL_SECONDS = 5
MESHY_POLL_TIMEOUT_SECONDS = 20 * 60
# Chibi ~1m aids pose estimation (spike_meshy_rig's setting for these rigs).
RIG_HEIGHT_METERS = 1.0


def load_ledger() -> dict:
    if not LEDGER_PATH.exists():
        raise SystemExit(
            f"{LEDGER_PATH} is missing — the 3D-master ledger is committed "
            "with the factory; restore it before registering"
        )
    return json.loads(LEDGER_PATH.read_text())


def save_ledger(ledger: dict) -> None:
    LEDGER_PATH.write_text(json.dumps(ledger, ensure_ascii=False, indent=2) + "\n")
    subprocess.run(
        ["pnpm", "exec", "biome", "format", "--write", str(LEDGER_PATH)], check=True
    )


def resolve_glb(value: str, work: Path, name: str) -> tuple[Path, str]:
    """(local path, R2 sha256) of a GLB given a content address or a local
    file; a local file is uploaded so the ledger only ever records custody
    the R2 store actually has."""
    work.mkdir(parents=True, exist_ok=True)
    if SHA256_PATTERN.fullmatch(value):
        dest = work / f"{name}.glb"
        if not (dest.exists() and sha256_of(dest) == value):
            dest.write_bytes(get_object(value))
        return dest, value
    path = Path(value)
    if not path.is_file():
        raise SystemExit(f"{name}: {value} is neither a sha256 nor a local file")
    sha = put_object(path.read_bytes())
    print(f"uploaded {name} to R2: {sha}")
    return path, sha


def blender(script: str, *args: str) -> str:
    """Run a factory bpy script under headless Blender, fail loud.

    --python-exit-code is required: without it Blender exits 0 even when
    the script raised (measured 2026-08-14). BLENDER_BIN selects a build —
    distro packages can ship a broken Cycles addon; the official tarball
    build renders headless.
    """
    import os

    cmd = [
        os.environ.get("BLENDER_BIN", "blender"),
        "-b", "--python-exit-code", "1",
        "-P", str(Path(__file__).resolve().parent / script),
        "--", *args,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise SystemExit(
            f"blender {script} failed:\n{result.stdout[-800:]}\n{result.stderr[-800:]}"
        )
    return result.stdout


# ---------------------------------------------------------------- register


def cmd_register_model(args: argparse.Namespace) -> None:
    if not args.approval.strip():
        raise SystemExit("--approval must record where the owner approved this model")
    ledger = load_ledger()
    work = args.workdir / f"model-{args.family}"
    # Custody check: both GLBs must exist on R2 and hash-verify (get_object
    # verifies; a wrong address fails loudly before the ledger is touched).
    rigged, rigged_sha = resolve_glb(args.rigged, work, "rigged")
    _, remesh_sha = resolve_glb(args.remesh, work, "remesh")
    ledger["models"].setdefault(args.family, {"motions": {}})
    entry = ledger["models"][args.family]
    entry.update(
        {
            "family": args.family,
            "riggedGlbSha256": rigged_sha,
            "remeshGlbSha256": remesh_sha,
            "provenance": args.provenance,
            "approval": args.approval,
            "registeredAt": time.strftime("%Y-%m-%d"),
        }
    )
    save_ledger(ledger)
    print(
        f"registered model {args.family}: rigged {rigged_sha[:12]}… "
        f"({rigged.stat().st_size} bytes), re-rig source {remesh_sha[:12]}…"
    )


def analyze_motion(glb: Path, work: Path, *, gait: bool) -> dict:
    """Bone-signature gates → the motion's loop window + measurements."""
    dump_path = work / "bones.json"
    blender("bpy_dump_bones.py", str(glb), str(dump_path))
    dump = json.loads(dump_path.read_text())
    substeps = dump["substeps"]
    signatures = np.array(dump["signatures"])
    window = bone_signature.scan_fundamental(signatures, substeps)
    start_frame = dump["frameStart"] + window.start / substeps
    cycle_frames = window.period / substeps
    report: dict = {
        "action": dump["action"],
        "startFrame": round(start_frame, 2),
        "cycleFrames": round(cycle_frames, 2),
        "relClosure": round(window.closure, 3),
        "loopMean": None if window.loop_mean is None else round(window.loop_mean, 3),
    }
    if gait:
        metrics = bone_signature.gait_metrics(
            np.array(dump["world"]["LeftFoot"]),
            np.array(dump["world"]["RightFoot"]),
            window.start,
            window.period,
        )
        failures = bone_signature.check_gait(metrics)
        if failures:
            for failure in failures:
                print(f"  - {failure}", file=sys.stderr)
            raise SystemExit("gait gate failed — not a full two-step cycle")
        report["gait"] = {
            "axis": "xy"[metrics.axis],
            "posSwing": round(metrics.pos_swing, 2),
            "negSwing": round(metrics.neg_swing, 2),
            "signFlips": metrics.sign_flips,
            "antiphase": round(metrics.antiphase, 2),
        }
    return report


def render_reference(glb: Path, work: Path, bone: dict) -> tuple[Path, dict]:
    """Green yaw45 reference video of the verified window, tiled ×3 and
    re-verified with the master-grade silhouette loop gates."""
    frames_n = round(bone["cycleFrames"])
    render_dir = work / "render"
    render_dir.mkdir(parents=True, exist_ok=True)
    for old in render_dir.glob("*.png"):
        old.unlink()
    blender(
        "bpy_render_loop.py",
        str(glb), str(render_dir),
        "--start-time", str(bone["startFrame"]),
        "--span", str(bone["cycleFrames"]),
        "--frames", str(frames_n),
        "--yaw", str(REFERENCE_YAW),
        "--resolution", str(REFERENCE_RESOLUTION),
    )
    rendered = sorted(render_dir.glob("frame_*.png"))
    if len(rendered) != frames_n:
        raise SystemExit(f"render produced {len(rendered)} frames, expected {frames_n}")

    green_dir = work / "green"
    green_dir.mkdir(exist_ok=True)
    for old in green_dir.glob("*.png"):
        old.unlink()
    for tile in range(REFERENCE_TILES):
        for index, path in enumerate(rendered):
            with Image.open(path) as frame:
                canvas = Image.new("RGB", frame.size, GREEN)
                canvas.paste(frame, (0, 0), frame)
            canvas.save(green_dir / f"green_{tile * frames_n + index:03d}.png")
    reference = work / "reference.mp4"
    run_quiet([
        "ffmpeg", "-y", "-loglevel", "error", "-framerate", str(REFERENCE_FPS),
        "-i", str(green_dir / "green_%03d.png"),
        "-an", "-c:v", "libx264", "-crf", "12", "-pix_fmt", "yuv420p",
        str(reference),
    ])

    # Re-verify the encoded video exactly the way a master registration
    # would consume it (green border, chroma key, silhouette loop gates).
    frame_paths = extract_frames(reference, work / "frames_reference")
    assert_green_background(frame_paths)
    masks = [silhouette_mask(img) for img in keyed_frames(frame_paths)]
    start, period, loop_mean, closure = find_loop(masks)
    if period != frames_n:
        raise SystemExit(
            f"tiled reference measures period {period}, expected {frames_n} — "
            "the render did not close its cycle"
        )
    return reference, {
        "frames": len(frame_paths),
        "fps": REFERENCE_FPS,
        "tiles": REFERENCE_TILES,
        "loop": {
            "start": start,
            "period": period,
            "loopMeanIou": round(loop_mean, 3),
            "closureIou": round(closure, 3),
        },
    }


def cmd_register_motion(args: argparse.Namespace) -> None:
    if not args.approval.strip():
        raise SystemExit("--approval must record where the owner approved this motion")
    ledger = load_ledger()
    if args.family not in ledger["models"]:
        raise SystemExit(
            f"no model registered for {args.family} — run register-model first "
            f"(available: {sorted(ledger['models'])})"
        )
    work = args.workdir / f"motion-{args.family}-{args.motion}"
    glb, glb_sha = resolve_glb(args.glb, work, "motion")

    bone = analyze_motion(glb, work, gait=not args.no_gait)
    print(f"bone loop: {json.dumps(bone, ensure_ascii=False)}")

    reference, reference_meta = render_reference(glb, work, bone)
    reference_sha = put_object(reference.read_bytes())
    print(f"uploaded reference to R2: {reference_sha}")

    ledger["models"][args.family]["motions"][args.motion] = {
        "preset": args.preset,
        "glbSha256": glb_sha,
        "boneLoop": bone,
        "reference": {"sha256": reference_sha, **reference_meta},
        "approval": args.approval,
        "registeredAt": time.strftime("%Y-%m-%d"),
    }
    save_ledger(ledger)
    print(
        f"registered {args.family}/{args.motion}: cycle {bone['cycleFrames']}f "
        f"@ {bone['startFrame']}f, closure {bone['relClosure']}, reference "
        f"{reference_meta['frames']} frames (IoU {reference_meta['loop']['loopMeanIou']}/"
        f"{reference_meta['loop']['closureIou']})"
    )


# ---------------------------------------------------------------- retarget


def meshy(method: str, path: str, *, missing_ok: bool = False, **kwargs) -> dict | None:
    import os

    key = os.environ.get("MESHY_API_KEY")
    if not key:
        raise SystemExit("MESHY_API_KEY is not set")
    response = requests.request(
        method, f"{MESHY_BASE}{path}",
        headers={"Authorization": f"Bearer {key}"}, timeout=120, **kwargs,
    )
    if missing_ok and response.status_code == 404:
        return None
    if response.status_code not in (200, 201, 202):
        raise SystemExit(
            f"Meshy {method} {path} failed: HTTP {response.status_code} "
            f"{response.text[:500]}"
        )
    return response.json()


class MeshyJobs:
    """Credit-metered, state-persisted Meshy tasks (spike_meshy_rig's
    submit/poll/meter contract, kept lane-local so the spike stays frozen)."""

    def __init__(self, work: Path, budget: float) -> None:
        work.mkdir(parents=True, exist_ok=True)
        # Distinct filename: fal_client.FalJobs shares the workdir and owns
        # state.json there — sharing one file would let either ledger clobber
        # the other (and a Fal-written file has no "spent" key).
        self.state_path = work / "meshy_state.json"
        self.budget = budget
        self.state: dict = (
            json.loads(self.state_path.read_text())
            if self.state_path.exists()
            else {}
        )
        self.state.setdefault("spent", 0.0)

    def save(self) -> None:
        self.state_path.write_text(json.dumps(self.state, indent=1))

    def submit(self, key: str, kind: str, payload: dict) -> str:
        tasks = self.state.setdefault("tasks", {})
        cached = tasks.get(key)
        if cached is not None and meshy("GET", f"/{kind}/{cached}", missing_ok=True) is None:
            # Meshy purges its tasks after ~3 days, so a cached id is only a
            # shortcut — once it 404s, drop it and re-submit from the durable
            # inputs instead of failing in poll.
            print(f"  {key}: cached task {cached} purged by Meshy — re-submitting")
            del tasks[key]
            self.save()
        if key not in tasks:
            if self.state["spent"] >= self.budget:
                raise SystemExit(
                    f"credit budget exhausted: spent {self.state['spent']} "
                    f">= {self.budget} — stopping before {key}"
                )
            tasks[key] = meshy("POST", f"/{kind}", json=payload)["result"]
            self.save()
        return tasks[key]

    def poll(self, kind: str, task_id: str) -> dict:
        deadline = time.time() + MESHY_POLL_TIMEOUT_SECONDS
        while True:
            data = meshy("GET", f"/{kind}/{task_id}")
            status = data["status"]
            if status == "SUCCEEDED":
                spent = data.get("consumed_credits")
                metered = self.state.setdefault("metered", [])
                if spent and task_id not in metered:
                    self.state["spent"] += float(spent)
                    metered.append(task_id)
                    self.save()
                return data
            if status in ("FAILED", "CANCELED"):
                raise SystemExit(f"task {task_id} ended {status}: {json.dumps(data)[:800]}")
            if time.time() > deadline:
                raise SystemExit(f"task {task_id} still {status} after {MESHY_POLL_TIMEOUT_SECONDS}s")
            print(f"  {task_id}: {status} {data.get('progress', '?')}%", flush=True)
            time.sleep(MESHY_POLL_SECONDS)


def download_url(url: str, dest: Path) -> Path:
    if not dest.exists():
        response = requests.get(url, timeout=300)
        response.raise_for_status()
        dest.write_bytes(response.content)
    print(f"  downloaded {dest.name} ({dest.stat().st_size} bytes)")
    return dest


def cmd_retarget(args: argparse.Namespace) -> None:
    ledger = load_ledger()
    model = ledger["models"].get(args.family)
    if model is None:
        raise SystemExit(f"no model registered for {args.family} — run register-model first")
    work = args.workdir / f"retarget-{args.family}"
    work.mkdir(parents=True, exist_ok=True)

    action_id = resolve_action_ids([args.preset])[args.preset]
    balance = meshy("GET", "/balance")["balance"]
    print(f"[balance] {balance} credits — preset {args.preset} = action {action_id}")

    # The stored remesh GLB is the durable re-rig source: Meshy purges its
    # own tasks after ~3 days (every 2026-08-10/11 rig task measured 404 on
    # 2026-08-14), so a live rig_task_id can never be assumed — each
    # retargeting session re-rigs from R2 bytes via `model_url` (5cr) and
    # then mints presets against the fresh rig (3cr each).
    remesh, _ = resolve_glb(model["remeshGlbSha256"], work, "remesh")
    jobs = MeshyJobs(work, args.budget)
    fal = fal_client.FalJobs(work, budget=0.0)  # uploads are free — no fal spend
    model_url = fal.upload(remesh)

    rig_key = f"rig_{model['remeshGlbSha256'][:12]}_h{RIG_HEIGHT_METERS:g}"
    rig_id = jobs.submit(
        rig_key, "rigging",
        {"model_url": model_url, "height_meters": RIG_HEIGHT_METERS},
    )
    print(f"[rig] task {rig_id}")
    rig = jobs.poll("rigging", rig_id)["result"]
    outputs: dict[str, Path] = {}
    outputs["rigged"] = download_url(
        rig["rigged_character_glb_url"], work / f"{rig_key}_character.glb"
    )
    basic = rig.get("basic_animations") or {}
    for name in ("walking", "running"):
        url = basic.get(f"{name}_glb_url", "")
        if url:
            outputs[name] = download_url(url, work / f"{rig_key}_{name}.glb")

    anim_key = f"anim_{rig_key}_{args.preset}"
    anim_id = jobs.submit(
        anim_key, "animations", {"rig_task_id": rig_id, "action_id": action_id}
    )
    print(f"[anim {args.preset}] task {anim_id}")
    anim = jobs.poll("animations", anim_id)["result"]
    outputs[args.preset] = download_url(
        anim["animation_glb_url"], work / f"{anim_key}.glb"
    )

    print(f"credits spent this session: {jobs.state['spent']}")
    for name, path in outputs.items():
        sha = put_object(path.read_bytes())
        print(f"R2 {name}: {sha}")
    print(
        "next: register the motion GLB with register-motion "
        "(--glb <sha256 above>) — retarget mints bytes, the gate registers them"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    model = sub.add_parser("register-model", help="register a family's rigged GLB")
    model.add_argument("--family", required=True)
    model.add_argument("--rigged", required=True, help="R2 sha256 or local path")
    model.add_argument("--remesh", required=True,
                       help="R2 sha256 of the re-rig source (rigging model_url input)")
    model.add_argument("--provenance", required=True,
                       help="how the model was made (tasks, rounds, yield rows)")
    model.add_argument("--approval", required=True,
                       help="where the owner approved this model")
    model.add_argument("--workdir", type=Path, default=DEFAULT_WORKDIR)

    motion = sub.add_parser("register-motion", help="gate + register one motion GLB")
    motion.add_argument("--family", required=True)
    motion.add_argument("--motion", required=True)
    motion.add_argument("--glb", required=True, help="R2 sha256 or local path")
    motion.add_argument("--preset", required=True,
                        help="Meshy catalog preset the GLB was minted from")
    motion.add_argument("--approval", required=True)
    motion.add_argument("--no-gait", action="store_true",
                        help="skip the two-step gait gate (non-gait motions)")
    motion.add_argument("--workdir", type=Path, default=DEFAULT_WORKDIR)

    retarget = sub.add_parser("retarget", help="re-rig from R2 + mint one preset")
    retarget.add_argument("--family", required=True)
    retarget.add_argument("--preset", required=True, help="catalog key or display name")
    retarget.add_argument("--budget", type=float, default=20.0, help="credit stop")
    retarget.add_argument("--workdir", type=Path, default=DEFAULT_WORKDIR)

    args = parser.parse_args()
    if args.command == "register-model":
        cmd_register_model(args)
    elif args.command == "register-motion":
        cmd_register_motion(args)
    elif args.command == "retarget":
        cmd_retarget(args)


if __name__ == "__main__":
    main()
