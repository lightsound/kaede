#!/usr/bin/env python3
"""Asset generation via Cloudflare AI Gateway (Phase 5 ①b — factory stage ②).

Calls any model in the AI Gateway catalog through the unified-billing REST
API (`/ai/run`): no provider keys, one prepaid credit balance, every request
logged on the `kaede-assets` gateway. The walk-quality bench (ROADMAP ①b(c),
2026-08-08) established the working recipe this script exists to reproduce:

- Walk/gesture cycles: an image-to-video model (`alibaba/wan-2.7-i2v`,
  $0.50/clip) animating the character's stand frame with an
  exaggerated-swing walk-in-place prompt, then sampling one stride's frames.
  Static image models cannot draw the alternating contact poses (every
  attempt collapses both contacts onto one stride — measured 5 ways).
- Still poses / sheets: `google/nano-banana-2` had the best style fidelity
  to the character reference (~$0.10/image).

Usage:
    CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... \
    python3 scripts/generate-via-ai-gateway.py \
        --model alibaba/wan-2.7-i2v --prompt "..." \
        --image path/to/reference.png --field image \
        --out /tmp/out/walk

Image inputs are inlined as data URIs. `--field` names the model's image
parameter (`image` for wan i2v; `image_input` — a list — for seedream /
nano-banana; probe a model's schema by sending `{}` and reading the
validation error, which lists the valid fields and bills nothing).
The token needs Workers AI:Read (inference) on top of the AI Gateway
permissions (gateway management); unified billing also requires the gateway
to have authentication enabled.
"""

import argparse
import base64
import json
import os
import sys
import time
import urllib.request

GATEWAY = "kaede-assets"
LIST_FIELDS = {"image_input", "images"}
OUTPUT_KEYS = ("image", "images", "video", "videos", "output")


def data_uri(path: str) -> str:
    with open(path, "rb") as f:
        return "data:image/png;base64," + base64.b64encode(f.read()).decode()


def run_model(account: str, token: str, gateway: str, model: str, model_input: dict) -> dict:
    req = urllib.request.Request(
        f"https://api.cloudflare.com/client/v4/accounts/{account}/ai/run",
        data=json.dumps({"model": model, "input": model_input}).encode(),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "cf-aig-gateway-id": gateway,
        },
    )
    started = time.time()
    with urllib.request.urlopen(req, timeout=900) as r:
        response = json.load(r)
    state = response.get("result", {}).get("state")
    print(f"[{model}] {time.time() - started:.1f}s state={state}", file=sys.stderr)
    return response


def output_urls(response: dict) -> list[str]:
    result = response.get("result", {}).get("result", {})
    urls: list[str] = []
    for key in OUTPUT_KEYS:
        value = result.get(key)
        if isinstance(value, str):
            urls.append(value)
        if isinstance(value, list):
            urls += [v for v in value if isinstance(v, str)]
    return urls


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True)
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--image", action="append", default=[], help="reference image path(s)")
    parser.add_argument("--field", default="image_input", help="the model's image input field")
    parser.add_argument("--param", action="append", default=[], help="extra input field, key=value")
    parser.add_argument("--gateway", default=GATEWAY)
    parser.add_argument("--out", required=True, help="output path prefix")
    args = parser.parse_args()

    account = os.environ["CLOUDFLARE_ACCOUNT_ID"]
    token = os.environ["CLOUDFLARE_API_TOKEN"]

    model_input: dict = {"prompt": args.prompt}
    if args.image:
        uris = [data_uri(p) for p in args.image]
        model_input[args.field] = uris if args.field in LIST_FIELDS else uris[0]
    for param in args.param:
        key, _, value = param.partition("=")
        model_input[key] = value

    response = run_model(account, token, args.gateway, args.model, model_input)
    urls = output_urls(response)
    if not urls:
        print(json.dumps(response, indent=2)[:2000], file=sys.stderr)
        raise SystemExit("no output urls in response")
    for i, url in enumerate(urls):
        clean = url.split("?")[0]
        ext = ".mp4" if clean.endswith(".mp4") else ".png"
        path = f"{args.out}_{i}{ext}"
        urllib.request.urlretrieve(url, path)
        print(path)


if __name__ == "__main__":
    main()
