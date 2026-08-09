#!/usr/bin/env python3
"""Asset-original store on R2 (ROADMAP Phase 5 ①b⑶ — clone-size control).

Generation originals (the green-screen sheets / one-shots named
`*-original.png`) are NOT committed: one original is 300KB–1.3MB versus
~60KB of imported frames, and every regeneration would grow every future
clone forever. They live in the R2 bucket `kaede-asset-originals` (IaC:
infra/alchemy.run.ts, the kaede-recordings precedent), addressed BY
CONTENT: key = `originals/<sha256><ext>`. The content address makes the
store immutable and self-verifying — the order.json that names an original
records its sha256 in an `originals` map ({order-relative path: sha256}),
the key derives from that hash, and a fetched body is hashed and compared
before use, so a re-import either reproduces the committed manifests
exactly or fails loudly.

Resolution rule (resolve_original): a locally present file wins — the
generate → import loop keeps working before anything is uploaded — and a
missing file is fetched from R2 into its recorded local path (gitignored)
so later runs are offline again. Reference hashing (reference_sha256)
short-circuits to the recorded hash when the file is absent: hashing is
the only thing a reference is needed for, so downloading megabytes just to
re-derive a recorded value would be waste. Local-wins is only for entries
the order does not record yet (the first generation of a new asset): a
recorded original whose on-disk bytes drifted is an un-uploaded
regeneration, and importing it would mint a manifest a fresh clone — which
resolves the RECORDED bytes — can never reproduce (worst on shared
references, where it silently rewrites ANOTHER asset's referenceHashes
behind a gitignored image), so that mismatch fails loudly instead.

Transport is the Cloudflare REST API (bearer CLOUDFLARE_API_TOKEN — the
token this repo's tooling already holds; R2 object PUT/GET measured
working with it 2026-08-09), not the S3 API: no SigV4, no second
credential. This is a dev-time store — the client and the SpacetimeDB
module never read it.
"""

import hashlib
import os
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ACCOUNT_ID = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "751c8a59858c9c04a8e722df7330444d")
BUCKET = os.environ.get("KAEDE_ASSET_ORIGINALS_BUCKET", "kaede-asset-originals")


def sha256_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def object_key(sha256: str, name: str) -> str:
    return f"originals/{sha256}{Path(name).suffix}"


def _object_url(key: str) -> str:
    return (
        f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}"
        # Cloudflare's R2 object-key encoding keeps `/` literal (path
        # separators); percent-encoding the slash works today but is outside
        # the documented contract (thermos Low).
        f"/r2/buckets/{BUCKET}/objects/{urllib.parse.quote(key, safe='/')}"
    )


def _token() -> str:
    token = os.environ.get("CLOUDFLARE_API_TOKEN")
    if not token:
        raise SystemExit(
            "CLOUDFLARE_API_TOKEN is not set — the asset-original store on R2 "
            "needs the R2-granted deploy token (README「手動デプロイ（逃げ道）」の"
            "前提を参照。R2 権限は録画バケットのため 2026-08-06 に付与済み)"
        )
    return token


def _request(key: str, *, body: bytes | None = None) -> bytes:
    method = "GET" if body is None else "PUT"
    request = urllib.request.Request(
        _object_url(key),
        data=body,
        method=method,
        headers={
            "Authorization": f"Bearer {_token()}",
            **({} if body is None else {"Content-Type": "application/octet-stream"}),
        },
    )
    try:
        with urllib.request.urlopen(request) as response:
            return response.read()
    except urllib.error.HTTPError as error:
        raise SystemExit(f"R2 {method} {key} failed: {error.code} {error.read().decode(errors='replace')}")


def fetch_original(rel: str, sha256: str, dest: Path) -> Path:
    key = object_key(sha256, rel)
    print(f"fetching {rel} from R2 ({key})")
    fetched = _request(key)
    digest = hashlib.sha256(fetched).hexdigest()
    if digest != sha256:
        raise SystemExit(f"R2 object {key} hashed to {digest}, expected {sha256} — refusing to import")
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(fetched)
    return dest


def _verified_local_sha256(path: Path, rel: str, originals: dict[str, str]) -> str:
    """The local file's sha256, failed loudly when it contradicts the order
    (an un-uploaded regeneration — see the module doc's local-wins caveat)."""
    digest = sha256_of(path)
    recorded = originals.get(rel)
    if recorded is not None and digest != recorded:
        raise SystemExit(
            f"{path} hashes to {digest} but the order records {recorded} — "
            "regenerated original? run scripts/upload-asset-originals.py on any "
            "order that names it (it re-records every order that shares the file), "
            "then re-import"
        )
    return digest


def _recorded_sha256(path: Path, rel: str, originals: dict[str, str]) -> str:
    sha256 = originals.get(rel)
    if sha256 is None:
        raise SystemExit(
            f"{path} is neither on disk nor in the order's originals map — "
            "run scripts/upload-asset-originals.py after generating"
        )
    return sha256


def resolve_original(base: Path, rel: str, originals: dict[str, str]) -> Path:
    """The order input `rel` as a local path, fetched from R2 when absent."""
    path = base / rel
    if path.exists():
        _verified_local_sha256(path, rel, originals)
        return path
    return fetch_original(rel, _recorded_sha256(path, rel, originals), path)


def reference_sha256(base: Path, rel: str, originals: dict[str, str]) -> str:
    """The reference's sha256 without a needless download (see module doc)."""
    path = base / rel
    if path.exists():
        return _verified_local_sha256(path, rel, originals)
    return _recorded_sha256(path, rel, originals)


def upload_original(path: Path) -> str:
    """PUT the file at its content address; idempotent by construction."""
    body = path.read_bytes()
    sha256 = hashlib.sha256(body).hexdigest()
    _request(object_key(sha256, path.name), body=body)
    return sha256
