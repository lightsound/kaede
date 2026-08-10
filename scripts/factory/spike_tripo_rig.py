#!/usr/bin/env python3
"""DP-B follow-up spike: image -> auto-rigged 3D -> preset dance via Tripo V3
(avatar-rig.md §6 DP-B 追記 2026-08-10 — the "image-to-3D auto-rigging" path).

Kept as the experiment's reproduction tool (the spike_blender_bake.py
precedent). Not part of the production factory line.

Pipeline (all Tripo API V3 — V2 retires 2026-11, do not use):
  upload    POST /v3/files                      (free)
  model     POST /v3/generation/image-to-model  (~20-30 credits)
  rig-check POST /v3/animations/rig-check       (free — always run before rig)
  rig       POST /v3/animations/rig             (~25 credits, v1.0-20240301 =
                                                 the biped rig that unlocks the
                                                 90+ presets incl. dance_01-06)
  retarget  POST /v3/animations/retarget        (~10 credits/animation)

Every completed task is recorded in <workdir>/state.json so re-runs never
re-spend credits, and every output URL (expires in 5 minutes) is downloaded
immediately into <workdir>. Credit spend is metered from each task's
credits_consumed and the run aborts beyond --budget.

Usage:
    export TRIPO_API_KEY=...
    python3 scripts/factory/spike_tripo_rig.py <input.png> <workdir> \
        [--animations preset:biped:dance_01 ...] [--budget 300]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
import urllib.request
from pathlib import Path

import requests

BASE = "https://openapi.tripo3d.ai/v3"
POLL_SECONDS = 3
POLL_TIMEOUT_SECONDS = 15 * 60
IMAGE_MODEL = "v3.1-20260211"
RIG_MODEL = "v1.0-20240301"  # biped-only version; the dance presets need it


def headers() -> dict[str, str]:
    import os

    key = os.environ.get("TRIPO_API_KEY")
    if not key:
        raise SystemExit("TRIPO_API_KEY is not set")
    return {"Authorization": f"Bearer {key}"}


def api(method: str, path: str, **kwargs) -> dict:
    response = requests.request(method, f"{BASE}{path}", headers=headers(), timeout=60, **kwargs)
    body = response.json()
    if response.status_code != 200 or body.get("code") != 0:
        raise SystemExit(f"Tripo {method} {path} failed: HTTP {response.status_code} {body}")
    return body["data"]


class Spike:
    def __init__(self, work: Path, budget: float) -> None:
        self.work = work
        self.budget = budget
        self.state_path = work / "state.json"
        self.state: dict = (
            json.loads(self.state_path.read_text()) if self.state_path.exists() else {"spent": 0.0}
        )

    def save(self) -> None:
        self.state_path.write_text(json.dumps(self.state, indent=1))

    def check_budget(self) -> None:
        if self.state["spent"] >= self.budget:
            raise SystemExit(
                f"credit budget exhausted: spent {self.state['spent']} >= {self.budget} — stopping"
            )

    def poll(self, task_id: str) -> dict:
        deadline = time.time() + POLL_TIMEOUT_SECONDS
        while True:
            data = api("GET", f"/tasks/{task_id}")
            status = data["status"]
            if status == "success":
                spent = data.get("credits_consumed")
                metered = self.state.setdefault("metered", [])
                if spent and task_id not in metered:
                    self.state["spent"] += float(spent)
                    metered.append(task_id)
                    self.save()
                return data
            if status in ("failed", "cancelled", "banned", "expired"):
                raise SystemExit(f"task {task_id} ended {status}: {json.dumps(data)}")
            if time.time() > deadline:
                raise SystemExit(f"task {task_id} still {status} after {POLL_TIMEOUT_SECONDS}s")
            print(f"  {task_id}: {status} {data.get('progress', '?')}%", flush=True)
            time.sleep(POLL_SECONDS)

    def download(self, url: str, dest: Path) -> Path:
        # Output URLs expire 5 minutes after task success — call right away.
        with urllib.request.urlopen(url, timeout=120) as response:
            dest.write_bytes(response.read())
        print(f"  downloaded {dest} ({dest.stat().st_size} bytes)")
        return dest

    def step(self, key: str, run) -> dict:
        """Run a paid step once; the recorded result survives re-runs."""
        if key in self.state:
            print(f"[{key}] cached: {json.dumps(self.state[key])[:120]}")
            return self.state[key]
        self.check_budget()
        self.state[key] = run()
        self.save()
        return self.state[key]

    def submit(self, key: str, request) -> str:
        """Persist a task id the moment it is submitted, so a crash later in the
        step (e.g. during download) resumes the same task instead of paying for
        a new one."""
        tasks = self.state.setdefault("tasks", {})
        if key not in tasks:
            tasks[key] = request()
            self.save()
        return tasks[key]

    def download_outputs(self, key: str, task: dict) -> None:
        """Save every *_url in a task's output next to the state file."""
        output = task.get("output", {})
        for name, value in output.items():
            urls = value if isinstance(value, list) else [value]
            for index, url in enumerate(urls):
                if not (isinstance(url, str) and url.startswith("http")):
                    continue
                suffix = Path(url.split("?")[0]).suffix or ".bin"
                stem = f"{key}_{name}" + (f"_{index}" if isinstance(value, list) else "")
                dest = self.work / f"{stem}{suffix}"
                if not dest.exists():
                    self.download(url, dest)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", type=Path)
    parser.add_argument("workdir", type=Path)
    parser.add_argument(
        "--animations",
        nargs="+",
        default=["preset:biped:dance_01", "preset:biped:dance_02"],
        help="preset ids from developers.tripo3d.ai (rig v1.0 biped list)",
    )
    parser.add_argument("--budget", type=float, default=300.0)
    args = parser.parse_args()
    args.workdir.mkdir(parents=True, exist_ok=True)
    spike = Spike(args.workdir, args.budget)

    # Step keys carry a fingerprint of their inputs, so re-running with a
    # different image (or animation list, below) never reuses a stale cache.
    image_bytes = args.image.read_bytes()
    digest = hashlib.sha256(image_bytes).hexdigest()[:12]

    upload = spike.step(
        f"upload_{digest}",
        lambda: api(
            "POST",
            "/files",
            files={"file": (args.image.name, image_bytes, "image/png")},
        ),
    )

    model_key = f"model_{digest}"

    def make_model() -> dict:
        task_id = spike.submit(
            model_key,
            lambda: api(
                "POST",
                "/generation/image-to-model",
                json={
                    "input": upload["file_token"],
                    "model": IMAGE_MODEL,
                    "texture": True,
                    # Flat colors are re-lit at render time with emission; PBR maps
                    # would only add CG shading (the exact risk this spike probes).
                    "pbr": False,
                    "texture_alignment": "original_image",
                },
            )["task_id"],
        )
        print(f"[model] task {task_id}")
        task = spike.poll(task_id)
        spike.download_outputs(model_key, task)
        return {"task_id": task_id, "output_keys": list(task.get("output", {}))}

    model = spike.step(model_key, make_model)

    rig_check_key = f"rig_check_{digest}"

    def make_rig_check() -> dict:
        # rig-check is async like every other V3 task (free, ~seconds).
        task_id = spike.submit(
            rig_check_key,
            lambda: api("POST", "/animations/rig-check", json={"input": model["task_id"]})[
                "task_id"
            ],
        )
        return spike.poll(task_id)["output"]

    rig_check = spike.step(rig_check_key, make_rig_check)
    print(f"[rig-check] {json.dumps(rig_check)}")
    if not rig_check.get("riggable", False):
        raise SystemExit("rig-check says the model is not riggable — stopping before paid rig")

    rig_key = f"rig_{digest}"

    def make_rig() -> dict:
        task_id = spike.submit(
            rig_key,
            lambda: api(
                "POST",
                "/animations/rig",
                json={
                    "input": model["task_id"],
                    "model": RIG_MODEL,
                    "rig_type": rig_check.get("rig_type") or "biped",
                    "spec": "tripo",
                    "out_format": "glb",
                },
            )["task_id"],
        )
        print(f"[rig] task {task_id}")
        task = spike.poll(task_id)
        spike.download_outputs(rig_key, task)
        return {"task_id": task_id}

    rig = spike.step(rig_key, make_rig)

    animations_digest = hashlib.sha256(" ".join(args.animations).encode()).hexdigest()[:12]
    retarget_key = f"retarget_{digest}_{animations_digest}"

    def make_retarget() -> dict:
        task_id = spike.submit(
            retarget_key,
            lambda: api(
                "POST",
                "/animations/retarget",
                json={
                    "input": rig["task_id"],
                    "animations": args.animations,
                    "out_format": "glb",
                    "bake_animation": True,
                    "animate_in_place": True,
                },
            )["task_id"],
        )
        print(f"[retarget] task {task_id}")
        task = spike.poll(task_id)
        spike.download_outputs(retarget_key, task)
        return {"task_id": task_id, "animations": args.animations}

    spike.step(retarget_key, make_retarget)
    print(f"DONE — credits spent this run (metered): {spike.state['spent']}")


if __name__ == "__main__":
    main()
    sys.exit(0)
