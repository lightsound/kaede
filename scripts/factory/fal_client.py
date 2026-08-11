"""fal.ai access through the Cloudflare AI Gateway BYOK route (the PR #101
spike's client, promoted for the production replace lane).

Everything goes through the kaede-assets gateway — the only credential is
CLOUDFLARE_API_TOKEN (the gateway injects the fal key). Long jobs use the
fal queue API via the x-fal-target-url header; input files are hosted once
on the fal CDN (persistent URL — no external temp-host dependency).

Every paid run is keyed in <workdir>/state.json so re-runs never re-spend,
and a run aborts when the estimated total would exceed the budget. The
gateway logs report cost=0 for every BYOK request (measured 2026-08-11 —
factory-yield.md), so actual spend is reconciled against the fal balance
API; `print_costs` prints that balance first, then recent request statuses.

Billing probes: empty-input requests fail validation and bill nothing, but
the queue API accepts them and only surfaces the 422 on the response fetch —
the sync API (no x-fal-target-url) rejects immediately.
"""

from __future__ import annotations

import hashlib
import json
import os
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
# model llms.txt (fal.ai/models/<model_id>/llms.txt, checked 2026-08-11) and
# confirmed against the fal balance during the PR #101 spike.
WAN_ANIMATE_RATES = {"480p": 0.04, "580p": 0.06, "720p": 0.08}
KLING_V26_STANDARD_MC_RATE_PER_SECOND = 0.07

WAN_ANIMATE_REPLACE = "fal-ai/wan/v2.2-14b/animate/replace"


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
        if resolution not in WAN_ANIMATE_RATES:
            raise SystemExit(
                f"no pricing rule for resolution {resolution!r} — "
                f"expected one of {sorted(WAN_ANIMATE_RATES)}"
            )
        return frames / 16 * WAN_ANIMATE_RATES[resolution]
    if model == "fal-ai/kling-video/v2.6/standard/motion-control":
        return duration * KLING_V26_STANDARD_MC_RATE_PER_SECOND
    raise SystemExit(f"no pricing rule for {model} — add one before spending")


class FalJobs:
    """Budget-metered, state-persisted fal queue runs (one paid run per key)."""

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
        # Atomic replace: state.json is the money ledger — a crash inside a
        # truncate-then-write would force a delete-and-re-pay recovery.
        scratch = self.state_path.with_suffix(".json.tmp")
        scratch.write_text(json.dumps(self.state, indent=1))
        os.replace(scratch, self.state_path)

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
                        "re-run with the same key to re-fetch"
                    )
                return response.json()
            if status.get("status") in ("FAILED", "CANCELED"):
                raise RunFailed(
                    f"request {run['request_id']} ended {status.get('status')}: "
                    f"{json.dumps(status)[:800]}"
                )
            if time.time() > deadline:
                raise SystemExit(
                    f"request {run['request_id']} still "
                    f"{status.get('status')} after {POLL_TIMEOUT_SECONDS}s"
                )
            print(f"  {run['request_id']}: {status.get('status')} qpos={status.get('queue_position')}", flush=True)
            time.sleep(POLL_SECONDS)

    def run(self, key: str, model: str, payload: dict, est_cost: float) -> dict:
        runs = self.state.setdefault("runs", {})
        record = runs.get(key)
        if record and (record.get("model") != model or record.get("payload") != payload):
            raise SystemExit(
                f"[{key}] was already run with a different model or inputs — "
                "pick a new key instead of reusing this one"
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
            # This file is the artifact real money bought and the exists()
            # guard makes it final: status-check + temp-then-rename so an
            # error body or a truncated transfer can never be cached as it.
            response = requests.get(url, timeout=300)
            response.raise_for_status()
            scratch = dest.with_suffix(".mp4.partial")
            scratch.write_bytes(response.content)
            os.replace(scratch, dest)
        print(f"[{key}] output {dest} ({dest.stat().st_size} bytes)")
        return dest


def print_costs(limit: int) -> None:
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
        params={"per_page": limit, "order_by": "created_at", "direction": "desc"},
        timeout=60,
    )
    entries = response.json().get("result", [])
    for entry in entries:
        print(
            f"{entry.get('created_at')} {entry.get('provider'):>10} "
            f"{entry.get('model') or entry.get('path', ''):<50} "
            f"status={entry.get('status_code')} cost={entry.get('cost')}"
        )
