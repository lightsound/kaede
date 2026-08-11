#!/usr/bin/env python3
"""DP-B follow-up spike #3: motion-transfer restyling via fal.ai through the
Cloudflare AI Gateway BYOK route (avatar-rig.md §6 DP-B — the spike design
recorded with the fal decision on 2026-08-11; PR #98 is the precedent for
the verdict material, spike_meshy_rig.py for the tool design).

Kept as the experiment's reproduction tool. Not part of the production
factory line.

Access: everything goes through the kaede-assets AI Gateway with BYOK — the
only credential needed is CLOUDFLARE_API_TOKEN (the gateway injects the fal
key). Long jobs use the fal queue API via the x-fal-target-url header; input
files are hosted once on the fal CDN (persistent URL — removes the external
temp-host dependency measured in PR #98).

Billing probes: empty-input requests fail validation and bill nothing, but
note the queue API accepts them into the queue and only surfaces the 422 on
the response fetch — the sync API (no x-fal-target-url) rejects immediately.

Every paid run is keyed by model + input digests in <workdir>/state.json so
re-runs never re-spend, and the run aborts when the estimated total would
exceed --budget. Note the gateway logs report cost=0 for every BYOK request
(measured 2026-08-11 — factory-yield.md), so actual spend is reconciled
against the fal balance API; the `costs` subcommand prints that balance
first, then the recent request statuses.

Usage:
    export CLOUDFLARE_API_TOKEN=...
    python3 scripts/factory/spike_fal_restyle.py <workdir> upload <file>
    python3 scripts/factory/spike_fal_restyle.py <workdir> run \
        --key replace_gangnam_girl \
        --model fal-ai/wan/v2.2-14b/animate/replace \
        --video /tmp/take.mp4 --image /tmp/girl_a_pose.jpg \
        [--resolution 480p] [--param character_orientation=video] [--budget 10]
    python3 scripts/factory/spike_fal_restyle.py <workdir> costs [--limit 20]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import requests

ACCOUNT_ID = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "751c8a59858c9c04a8e722df7330444d")
GATEWAY_BASE = f"https://gateway.ai.cloudflare.com/v1/{ACCOUNT_ID}/kaede-assets/fal"
QUEUE_BASE = "https://queue.fal.run"
STORAGE_INITIATE = "https://rest.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3"
POLL_SECONDS = 10
POLL_TIMEOUT_SECONDS = 30 * 60

# $ per billed "video second" (= 16 output frames), by resolution — from the
# model llms.txt (fal.ai/models/<model_id>/llms.txt, checked 2026-08-11).
WAN_ANIMATE_RATES = {"480p": 0.04, "580p": 0.06, "720p": 0.08}
KLING_V26_STANDARD_MC_RATE_PER_SECOND = 0.07


class RunFailed(SystemExit):
    """Terminal FAILED/CANCELED queue status — bills nothing on fal. Only
    these release the run key and refund the estimate: a COMPLETED job has
    already billed even when its response fetch errors, and a timed-out job
    may still complete and bill."""


def token() -> str:
    value = os.environ.get("CLOUDFLARE_API_TOKEN")
    if not value:
        raise SystemExit("CLOUDFLARE_API_TOKEN is not set")
    return value


def gateway(method: str, target_url: str, body: dict | None = None) -> requests.Response:
    """Call any fal endpoint through the AI Gateway (BYOK injects the fal key)."""
    return requests.request(
        method,
        GATEWAY_BASE,
        headers={
            "cf-aig-authorization": f"Bearer {token()}",
            "x-fal-target-url": target_url,
            "Content-Type": "application/json",
        },
        json=body,
        timeout=300,
    )


def video_probe(path: Path) -> tuple[int, float]:
    """(frame count, duration seconds) of a local video."""
    out = subprocess.run(
        [
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-count_frames", "-show_entries", "stream=nb_read_frames,duration",
            "-of", "json", str(path),
        ],
        capture_output=True, text=True, check=True,
    )
    stream = json.loads(out.stdout)["streams"][0]
    return int(stream["nb_read_frames"]), float(stream["duration"])


def sniff_content_type(data: bytes) -> str:
    """R2 originals are content-addressed (no extension) — sniff the bytes."""
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[4:8] == b"ftyp":
        return "video/mp4"
    raise SystemExit("unrecognized file type — expected png/jpeg/mp4")


def estimate_cost(model: str, resolution: str, frames: int, duration: float) -> float:
    if model.startswith("fal-ai/wan/v2.2-14b/animate/"):
        return frames / 16 * WAN_ANIMATE_RATES[resolution]
    if model == "fal-ai/kling-video/v2.6/standard/motion-control":
        return duration * KLING_V26_STANDARD_MC_RATE_PER_SECOND
    raise SystemExit(f"no pricing rule for {model} — add one before spending")


class Spike:
    def __init__(self, work: Path, budget: float) -> None:
        self.work = work
        self.budget = budget
        self.state_path = work / "state.json"
        self.state: dict = (
            json.loads(self.state_path.read_text())
            if self.state_path.exists()
            else {}
        )
        self.state.setdefault("spent_estimated", 0.0)

    def save(self) -> None:
        self.state_path.write_text(json.dumps(self.state, indent=1))

    def upload(self, path: Path) -> str:
        """Host a file on the fal CDN once; the URL is persistent and cached."""
        data = path.read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        uploads = self.state.setdefault("uploads", {})
        if digest in uploads:
            return uploads[digest]
        content_type = sniff_content_type(data)
        initiate = gateway(
            "POST", STORAGE_INITIATE,
            {"content_type": content_type, "file_name": path.name},
        )
        if initiate.status_code != 200:
            raise SystemExit(f"CDN initiate failed: {initiate.status_code} {initiate.text[:300]}")
        issued = initiate.json()
        # The signed PUT goes straight to the CDN host — no auth, no gateway.
        put = requests.put(
            issued["upload_url"], data=data,
            headers={"Content-Type": content_type}, timeout=300,
        )
        if put.status_code not in (200, 201, 204):
            raise SystemExit(f"CDN PUT failed: {put.status_code} {put.text[:300]}")
        uploads[digest] = issued["file_url"]
        self.save()
        print(f"[upload] {path.name} -> {issued['file_url']}")
        return issued["file_url"]

    def poll(self, run: dict) -> dict:
        deadline = time.time() + POLL_TIMEOUT_SECONDS
        while True:
            status = gateway("GET", run["status_url"]).json()
            if status.get("status") == "COMPLETED":
                response = gateway("GET", run["response_url"])
                if response.status_code != 200:
                    # COMPLETED means the job may have billed, so keep the
                    # record (a re-run re-fetches this response instead of
                    # paying for a new submission). Permanent 4xx here is a
                    # validation error that billed nothing, but the estimate
                    # stays charged — over-counting the budget is the safe
                    # direction.
                    raise SystemExit(
                        f"request {run['request_id']} response fetch failed: "
                        f"{response.status_code} {response.text[:800]} — "
                        "re-run with the same --key to re-fetch"
                    )
                return response.json()
            if status.get("status") in ("FAILED", "CANCELED"):
                raise RunFailed(
                    f"request {run['request_id']} ended {status.get('status')}: "
                    f"{json.dumps(status)[:800]}"
                )
            if time.time() > deadline:
                raise SystemExit(f"request {run['request_id']} still {status} after {POLL_TIMEOUT_SECONDS}s")
            print(f"  {run['request_id']}: {status.get('status')} qpos={status.get('queue_position')}", flush=True)
            time.sleep(POLL_SECONDS)

    def run(self, key: str, model: str, payload: dict, est_cost: float) -> dict:
        runs = self.state.setdefault("runs", {})
        record = runs.get(key)
        if record and (record.get("model") != model or record.get("payload") != payload):
            raise SystemExit(
                f"[{key}] was already run with a different model or inputs — "
                "pick a new --key instead of reusing this one"
            )
        if record and "result" in record:
            print(f"[{key}] cached: {json.dumps(record['result'])[:160]}")
            return record["result"]
        if record is None:
            if self.state["spent_estimated"] + est_cost > self.budget:
                raise SystemExit(
                    f"budget stop: {self.state['spent_estimated']:.2f} + {est_cost:.2f} "
                    f"> {self.budget:.2f} — not submitting {key}"
                )
            submit = gateway("POST", f"{QUEUE_BASE}/{model}", payload)
            if submit.status_code != 200:
                raise SystemExit(f"submit {key} failed: {submit.status_code} {submit.text[:800]}")
            # Persist the request id (and meter the spend) the moment it is
            # submitted, so a crash while polling resumes instead of re-paying.
            record = runs[key] = {"model": model, "payload": payload, "est_cost": est_cost, **submit.json()}
            self.state["spent_estimated"] += est_cost
            self.save()
            print(f"[{key}] submitted {record['request_id']} (est ${est_cost:.3f})")
        try:
            result = self.poll(record)
        except RunFailed:
            # fal bills nothing on FAILED/CANCELED, so release the key and
            # refund its estimate — a retry under the same key submits fresh.
            # Timeouts and response-fetch errors are NOT refunded: the job
            # may have billed (or may still bill), and keeping the record
            # lets a re-run resume instead of re-paying.
            self.state["spent_estimated"] -= record.get("est_cost", 0.0)
            del runs[key]
            self.save()
            raise
        record["result"] = result
        self.save()
        return result

    def download(self, key: str, url: str) -> Path:
        dest = self.work / f"{key}.mp4"
        if not dest.exists():
            dest.write_bytes(requests.get(url, timeout=300).content)
        print(f"[{key}] output {dest} ({dest.stat().st_size} bytes)")
        return dest


def cmd_run(spike: Spike, args: argparse.Namespace) -> None:
    payload: dict = {}
    for pair in args.param:
        name, _, raw = pair.partition("=")
        try:
            payload[name] = json.loads(raw)
        except json.JSONDecodeError:
            payload[name] = raw
    frames, duration = video_probe(args.video)
    payload["video_url"] = spike.upload(args.video)
    payload["image_url"] = spike.upload(args.image)
    if args.model.startswith("fal-ai/wan/"):
        payload.setdefault("resolution", args.resolution)
    est = estimate_cost(args.model, args.resolution, frames, duration)
    print(f"[{args.key}] {args.model} — {frames} frames / {duration:.2f}s, est ${est:.3f}")
    result = spike.run(args.key, args.model, payload, est)
    print(json.dumps({k: v for k, v in result.items() if k != "timings"}, indent=1)[:600])
    spike.download(args.key, result["video"]["url"])
    print(f"total estimated spend: ${spike.state['spent_estimated']:.3f} / {spike.budget:.2f}")


def cmd_costs(args: argparse.Namespace) -> None:
    """Print the fal balance (the real spend meter) + recent request statuses.

    The gateway log `cost` field is always 0 for BYOK requests (measured
    2026-08-11), so the balance delta is the only true cost reading.
    """
    balance = gateway("GET", "https://rest.fal.ai/billing/user_balance")
    balance.raise_for_status()
    print(f"fal balance: ${balance.text.strip()} (spend = starting balance - this)")
    response = requests.get(
        f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}"
        "/ai-gateway/gateways/kaede-assets/logs",
        headers={"Authorization": f"Bearer {token()}"},
        params={"per_page": args.limit, "order_by": "created_at", "direction": "desc"},
        timeout=60,
    )
    entries = response.json().get("result", [])
    for entry in entries:
        print(
            f"{entry.get('created_at')} {entry.get('provider'):>10} "
            f"{entry.get('model') or entry.get('path', ''):<50} "
            f"status={entry.get('status_code')} cost={entry.get('cost')}"
        )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("workdir", type=Path)
    sub = parser.add_subparsers(dest="command", required=True)

    up = sub.add_parser("upload", help="host a file on the fal CDN (cached, persistent URL)")
    up.add_argument("file", type=Path)

    run = sub.add_parser("run", help="queue-submit one motion-transfer generation")
    run.add_argument("--key", required=True, help="state key — one paid run per key")
    run.add_argument("--model", required=True)
    run.add_argument("--video", type=Path, required=True)
    run.add_argument("--image", type=Path, required=True)
    run.add_argument("--resolution", default="480p")
    run.add_argument(
        "--param", action="append", default=[],
        help="extra payload field name=value (value parsed as JSON when possible)",
    )
    run.add_argument("--budget", type=float, default=10.0, help="USD stop for the whole workdir")

    costs = sub.add_parser("costs", help="actual billed costs from the gateway logs")
    costs.add_argument("--limit", type=int, default=20)

    args = parser.parse_args()
    args.workdir.mkdir(parents=True, exist_ok=True)

    if args.command == "upload":
        Spike(args.workdir, budget=0.0).upload(args.file)
    elif args.command == "run":
        cmd_run(Spike(args.workdir, args.budget), args)
    elif args.command == "costs":
        cmd_costs(args)


if __name__ == "__main__":
    main()
    sys.exit(0)
