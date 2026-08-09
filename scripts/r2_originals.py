#!/usr/bin/env python3
"""Asset-original store on R2 (ROADMAP Phase 5 ①b⑶ — clone-size control).

Generation originals (the green-screen sheets / one-shots named
`*-original.png`) are NOT committed: one original is 300KB–1.3MB versus
~60KB of imported frames, and every regeneration would grow every future
clone forever. They live in the R2 bucket `kaede-asset-originals` (IaC:
infra/alchemy.run.ts, the kaede-recordings precedent), addressed BY
CONTENT: key = `originals/<sha256>`. The content address makes the store
immutable and self-verifying — the order.json that names an original
records its sha256 in an `originals` map ({order-relative path: sha256}),
the key derives only from that hash (not from a logical filename or
extension), and a fetched body is hashed and compared before use, so a
re-import either reproduces the committed manifests exactly or fails
loudly.

Resolution rule (resolve_original): a locally present file wins — the
generate → import loop keeps working before anything is uploaded — and a
missing file is fetched from R2 into its recorded local path (gitignored)
so later runs are offline again. Every order input and output path is
resolved below the canonical asset root; absolute paths and symlinks
outside it fail before any read or write. Reference hashing
(reference_sha256) short-circuits to the recorded hash when the file is
absent: hashing is the only thing a reference is needed for, so
downloading megabytes just to re-derive a recorded value would be waste.
Local-wins is only for entries the order does not record yet (the first
generation of a new asset): a recorded original whose on-disk bytes
drifted is an un-uploaded regeneration, and importing it would mint a
manifest a fresh clone — which resolves the RECORDED bytes — can never
reproduce (worst on shared references, where it silently rewrites ANOTHER
asset's referenceHashes behind a gitignored image), so that mismatch fails
loudly instead.

Transport is the Cloudflare REST API (bearer CLOUDFLARE_API_TOKEN — the
token this repo's tooling already holds; R2 object PUT/GET measured
working with it 2026-08-09), not the S3 API: no SigV4, no second
credential. This is a dev-time store — the client and the SpacetimeDB
module never read it.
"""

import hashlib
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ACCOUNT_ID = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "751c8a59858c9c04a8e722df7330444d")
BUCKET = os.environ.get("KAEDE_ASSET_ORIGINALS_BUCKET", "kaede-asset-originals")
R2_TIMEOUT_SECONDS = 30
R2_MAX_ATTEMPTS = 3
SHA256_PATTERN = re.compile(r"[0-9a-f]{64}\Z")


def sha256_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def object_key(sha256: str) -> str:
    """Return an extension-independent content address.

    A hash-only key keeps aliases and symlinked source names on the same
    object. The object is a PNG by pipeline contract, but its logical
    filename must not become part of the content address.
    """
    if not isinstance(sha256, str) or SHA256_PATTERN.fullmatch(sha256) is None:
        raise SystemExit(f"invalid SHA-256 content address: {sha256!r}")
    return f"originals/{sha256}"


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
    for attempt in range(R2_MAX_ATTEMPTS):
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
            with urllib.request.urlopen(request, timeout=R2_TIMEOUT_SECONDS) as response:
                return response.read()
        except urllib.error.HTTPError as error:
            detail = error.read().decode(errors="replace")
            if error.code < 500 or attempt == R2_MAX_ATTEMPTS - 1:
                raise SystemExit(f"R2 {method} {key} failed: {error.code} {detail}") from error
        except (TimeoutError, urllib.error.URLError) as error:
            if attempt == R2_MAX_ATTEMPTS - 1:
                raise SystemExit(f"R2 {method} {key} failed after {R2_MAX_ATTEMPTS} attempts: {error}") from error
        time.sleep(2**attempt)
    raise AssertionError("unreachable")


def validate_order_path(order_path: Path, asset_root: Path) -> Path:
    """Validate an order file itself before reading or later replacing it."""
    try:
        resolved = order_path.resolve(strict=False)
        resolved.relative_to(asset_root.resolve())
    except (OSError, RuntimeError, TypeError, ValueError) as error:
        raise SystemExit(f"order path must stay inside {asset_root}: {order_path}") from error
    if resolved.name != "order.json":
        raise SystemExit(f"order path must name order.json: {order_path}")
    return resolved


def resolve_asset_path(base: Path, rel: str, asset_root: Path) -> Path:
    """Resolve an order input without escaping the asset tree.

    `..` is allowed for current in-tree aliases such as
    `../avatar/sheet-original.png`; the resolved path, including symlinks,
    must remain below the canonical asset root. Absolute inputs are rejected
    explicitly so a manifest cannot choose an arbitrary local file.
    """
    raw = Path(rel)
    if raw.is_absolute():
        raise SystemExit(f"asset input must be relative: {rel}")
    try:
        resolved = (base / raw).resolve(strict=False)
        resolved.relative_to(asset_root.resolve())
    except (OSError, RuntimeError, TypeError, ValueError) as error:
        raise SystemExit(f"asset input escapes {asset_root}: {rel}") from error
    return resolved


def fetch_original(
    base: Path, rel: str, sha256: str, asset_root: Path
) -> Path:
    dest = resolve_asset_path(base, rel, asset_root)
    key = object_key(sha256)
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
    if not path.is_file():
        raise SystemExit(f"{path} is not a regular file")
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


def resolve_original(
    base: Path, rel: str, originals: dict[str, str], asset_root: Path
) -> Path:
    """The order input `rel` as a local path, fetched from R2 when absent."""
    path = resolve_asset_path(base, rel, asset_root)
    if path.exists():
        _verified_local_sha256(path, rel, originals)
        return path
    return fetch_original(
        base, rel, _recorded_sha256(path, rel, originals), asset_root
    )


def reference_sha256(
    base: Path, rel: str, originals: dict[str, str], asset_root: Path
) -> str:
    """The reference's sha256 without a needless download (see module doc)."""
    path = resolve_asset_path(base, rel, asset_root)
    if path.exists():
        return _verified_local_sha256(path, rel, originals)
    return _recorded_sha256(path, rel, originals)


def upload_original(path: Path) -> str:
    """PUT the file at its content address; idempotent by construction."""
    if not path.is_file():
        raise SystemExit(f"{path} is not a regular file")
    body = path.read_bytes()
    sha256 = hashlib.sha256(body).hexdigest()
    _request(object_key(sha256), body=body)
    return sha256
