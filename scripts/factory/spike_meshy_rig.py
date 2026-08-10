#!/usr/bin/env python3
"""DP-B follow-up spike #2: image -> auto-rigged 3D -> preset animations via
Meshy (avatar-rig.md §6 DP-B — the re-evaluation candidate named when Tripo
was rejected on 2026-08-10; PR #97 is the precedent for the verdict material).

Kept as the experiment's reproduction tool (the spike_tripo_rig.py
precedent). Not part of the production factory line.

Pipeline (Meshy OpenAPI v1 — base https://api.meshy.ai):
  balance   GET  /openapi/v1/balance        (free — connectivity check)
  model     POST /openapi/v1/image-to-3d    (meshy-5 + texture = 15 credits,
                                             the cheapest textured tier;
                                             meshy-6 = 30 via --ai-model)
  rig       POST /openapi/v1/rigging        (5 credits — ships free walking/
                                             running GLBs in the result)
  animate   POST /openapi/v1/animations     (3 credits per action; action_id
                                             is resolved by name at runtime
                                             from the public animation
                                             catalog, never hardcoded)

Every completed task is recorded in <workdir>/state.json so re-runs never
re-spend credits, and every output URL (expires in ~3 days) is downloaded
immediately into <workdir>. Credit spend is metered from each task's
consumed_credits (refunded on FAILED) and the run aborts beyond --budget.

Usage:
    export MESHY_API_KEY=...
    python3 scripts/factory/spike_meshy_rig.py <input.png> <workdir> \
        [--animations All_Night_Dance Cheer_with_Both_Hands_Up ...] \
        [--ai-model meshy-5] [--budget 150]
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import sys
import time
import urllib.request
from pathlib import Path

import requests

BASE = "https://api.meshy.ai/openapi/v1"
CATALOG_URL = "https://api.meshy.ai/web/public/animations/resources"
POLL_SECONDS = 5
POLL_TIMEOUT_SECONDS = 20 * 60


def headers() -> dict[str, str]:
    import os

    key = os.environ.get("MESHY_API_KEY")
    if not key:
        raise SystemExit("MESHY_API_KEY is not set")
    return {"Authorization": f"Bearer {key}"}


def api(method: str, path: str, **kwargs) -> dict:
    response = requests.request(method, f"{BASE}{path}", headers=headers(), timeout=120, **kwargs)
    if response.status_code not in (200, 201, 202):
        raise SystemExit(f"Meshy {method} {path} failed: HTTP {response.status_code} {response.text[:500]}")
    return response.json()


def resolve_action_ids(names: list[str]) -> dict[str, int]:
    """Look preset actions up by key or display name in the public catalog.

    action_id must never be hardcoded (task rule): ids come from the catalog
    at run time so a renumbered library fails loudly here, not mid-spend.
    """
    catalog = requests.get(CATALOG_URL, timeout=60).json()["result"]["list"]
    by_key = {entry["key"]: entry for entry in catalog}
    by_name = {entry["name"]: entry for entry in catalog}
    resolved: dict[str, int] = {}
    for name in names:
        entry = by_key.get(name) or by_name.get(name)
        if entry is None:
            raise SystemExit(f"animation {name!r} not found in the catalog ({len(catalog)} entries)")
        # Nearly the whole library (671/680 as of 2026-08) is rigType
        # "style_02" — that is the standard for API-rigged characters, only
        # the free walking/running pair is tagged "biped".
        resolved[name] = entry["id"]
    return resolved


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

    def poll(self, kind: str, task_id: str) -> dict:
        deadline = time.time() + POLL_TIMEOUT_SECONDS
        while True:
            data = api("GET", f"/{kind}/{task_id}")
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
                raise SystemExit(f"task {task_id} still {status} after {POLL_TIMEOUT_SECONDS}s")
            print(f"  {task_id}: {status} {data.get('progress', '?')}%", flush=True)
            time.sleep(POLL_SECONDS)

    def download(self, url: str, dest: Path) -> Path:
        with urllib.request.urlopen(url, timeout=300) as response:
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
        """Persist a task id the moment it is submitted, so a crash later in
        the step (e.g. during download) resumes the same task instead of
        paying for a new one."""
        tasks = self.state.setdefault("tasks", {})
        if key not in tasks:
            tasks[key] = request()
            self.save()
        return tasks[key]

    def download_urls(self, prefix: str, urls: dict[str, str]) -> None:
        for name, url in urls.items():
            if not (isinstance(url, str) and url.startswith("http")):
                continue
            suffix = Path(url.split("?")[0]).suffix or ".bin"
            dest = self.work / f"{prefix}_{name}{suffix}"
            if not dest.exists():
                self.download(url, dest)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", type=Path)
    parser.add_argument("workdir", type=Path)
    parser.add_argument(
        "--animations",
        nargs="+",
        default=[
            "All_Night_Dance",
            "Boom_Dance",
            "Gangnam_Groove",
            "Cheer_with_Both_Hands_Up",
            "Victory_Cheer",
        ],
        help="catalog keys or display names (looping dances + head-up cheers)",
    )
    parser.add_argument(
        "--ai-model",
        default="meshy-5",
        help="meshy-5 (15 credits with texture, cheapest) or meshy-6/latest (30)",
    )
    parser.add_argument("--height-meters", type=float, default=1.0, help="chibi ~1m aids pose estimation")
    parser.add_argument("--budget", type=float, default=150.0)
    args = parser.parse_args()
    args.workdir.mkdir(parents=True, exist_ok=True)
    spike = Spike(args.workdir, args.budget)

    balance = api("GET", "/balance")["balance"]
    print(f"[balance] {balance} credits")

    # Step keys carry a fingerprint of their inputs, so re-running with a
    # different image / model / animation list never reuses a stale cache.
    image_bytes = args.image.read_bytes()
    digest = hashlib.sha256(image_bytes).hexdigest()[:12] + f"_{args.ai_model}"
    data_uri = "data:image/png;base64," + base64.b64encode(image_bytes).decode()

    model_key = f"model_{digest}"

    def make_model() -> dict:
        payload = {
            "image_url": data_uri,
            "ai_model": args.ai_model,
            "should_texture": True,
            "enable_pbr": False,
            # The input is already a clean generated A-pose; keep the exact
            # appearance (no style processing) and target the standard glTF
            # forward direction that rigging pose estimation expects.
            "pose_mode": "a-pose",
            "target_formats": ["glb"],
        }
        if args.ai_model in ("meshy-6", "latest"):
            # Only supported on meshy-6/latest. remove_lighting directly
            # probes Tripo weakness ① (baked-in shading).
            payload["image_enhancement"] = False
            payload["remove_lighting"] = True
        task_id = spike.submit(model_key, lambda: api("POST", "/image-to-3d", json=payload)["result"])
        print(f"[model] task {task_id}")
        task = spike.poll("image-to-3d", task_id)
        spike.download_urls(model_key, {"glb": task["model_urls"].get("glb", ""), "thumbnail": task.get("thumbnail_url", "")})
        return {"task_id": task_id, "consumed_credits": task.get("consumed_credits")}

    model = spike.step(model_key, make_model)

    # height_meters scales the rig skeleton, so it is part of the rig
    # fingerprint — and of every animation derived from that rig.
    rig_digest = f"{digest}_h{args.height_meters:g}"
    rig_key = f"rig_{rig_digest}"

    def make_rig() -> dict:
        task_id = spike.submit(
            rig_key,
            lambda: api(
                "POST",
                "/rigging",
                json={"input_task_id": model["task_id"], "height_meters": args.height_meters},
            )["result"],
        )
        print(f"[rig] task {task_id}")
        task = spike.poll("rigging", task_id)
        result = task["result"]
        spike.download_urls(rig_key, {"character": result.get("rigged_character_glb_url", "")})
        basic = result.get("basic_animations") or {}
        spike.download_urls(
            rig_key,
            {
                "walking": basic.get("walking_glb_url", ""),
                "running": basic.get("running_glb_url", ""),
            },
        )
        return {"task_id": task_id, "consumed_credits": task.get("consumed_credits")}

    rig = spike.step(rig_key, make_rig)

    actions = resolve_action_ids(args.animations)
    print(f"[actions] {json.dumps(actions)}")
    for name, action_id in actions.items():
        anim_key = f"anim_{rig_digest}_{name}"

        def make_animation(name: str = name, action_id: int = action_id, anim_key: str = anim_key) -> dict:
            task_id = spike.submit(
                anim_key,
                lambda: api(
                    "POST",
                    "/animations",
                    json={"rig_task_id": rig["task_id"], "action_id": action_id},
                )["result"],
            )
            print(f"[anim {name}] task {task_id}")
            task = spike.poll("animations", task_id)
            spike.download_urls(anim_key, {"glb": task["result"].get("animation_glb_url", "")})
            return {"task_id": task_id, "action_id": action_id, "consumed_credits": task.get("consumed_credits")}

        spike.step(anim_key, make_animation)

    print(f"DONE — credits spent this run (metered): {spike.state['spent']}")


if __name__ == "__main__":
    main()
    sys.exit(0)
