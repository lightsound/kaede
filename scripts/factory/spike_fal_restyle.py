#!/usr/bin/env python3
"""DP-B follow-up spike #3: motion-transfer restyling via fal.ai through the
Cloudflare AI Gateway BYOK route (avatar-rig.md §6 DP-B — the spike design
recorded with the fal decision on 2026-08-11; PR #98 is the precedent for
the verdict material, spike_meshy_rig.py for the tool design).

Kept as the experiment's reproduction tool. The client mechanics (gateway,
CDN upload, budget-metered queue runs) were promoted into
factory/fal_client.py when the replace lane entered the production factory
(replace_lane.py); this CLI now rides that shared client unchanged.

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
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from factory.fal_client import FalJobs, estimate_cost, print_costs, video_probe  # noqa: E402


def cmd_run(jobs: FalJobs, args: argparse.Namespace) -> None:
    payload: dict = {}
    for pair in args.param:
        name, _, raw = pair.partition("=")
        try:
            payload[name] = json.loads(raw)
        except json.JSONDecodeError:
            payload[name] = raw
    frames, duration = video_probe(args.video)
    payload["video_url"] = jobs.upload(args.video)
    payload["image_url"] = jobs.upload(args.image)
    if args.model.startswith("fal-ai/wan/"):
        payload.setdefault("resolution", args.resolution)
    est = estimate_cost(args.model, args.resolution, frames, duration)
    print(f"[{args.key}] {args.model} — {frames} frames / {duration:.2f}s, est ${est:.3f}")
    result = jobs.run(args.key, args.model, payload, est)
    print(json.dumps({k: v for k, v in result.items() if k != "timings"}, indent=1)[:600])
    jobs.download(args.key, result["video"]["url"])
    print(f"total estimated spend: ${jobs.state['spent_estimated']:.3f} / {jobs.budget:.2f}")


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
        FalJobs(args.workdir, budget=0.0).upload(args.file)
    elif args.command == "run":
        cmd_run(FalJobs(args.workdir, args.budget), args)
    elif args.command == "costs":
        print_costs(args.limit)


if __name__ == "__main__":
    main()
    sys.exit(0)
