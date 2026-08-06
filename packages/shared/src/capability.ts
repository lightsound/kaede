// The Worker⇄SpacetimeDB trust anchor's capability format (ROADMAP
// Phase 4 増分⑤): a short-lived HMAC-signed pass the module mints for
// approved members and the call-API Worker verifies — how the Worker
// enforces the approval state only SpacetimeDB knows, without ever
// reading SpacetimeDB (the 増分① division of authority). The signer and
// the verifier share one secret per environment (the anchor — a private
// module row and a Worker secret, provisioned once; see README「通話 API
// Worker」), and BOTH directions of the anchor ride this file: the
// reverse direction (Worker→module webhook relays, a future increment)
// verifies hmacSha256Hex over its own payload with the same secret.
//
// The hashes are implemented in plain TypeScript deliberately: the
// SpacetimeDB module host exposes no WebCrypto (and crypto.subtle is
// async anyway, which a reducer cannot await), while the Worker reusing
// the exact same code means the two sides cannot disagree on a digest.
// Inputs are restricted to ASCII (hex identities, digits, the scope
// vocabulary), which keeps the byte encoding trivial and unambiguous.
// This file is deliberately self-contained — no imports, no exported
// types referencing other files — so it adds no type-coupling evidence
// edges (the fallow cap, see AGENTS.md).

/** The capability scope of the recording routes (一覧/DL・開始/停止). */
export const CAPABILITY_SCOPE_RECORDING = 'recording';

/**
 * How long one recording pass stays valid. Short — the pass only proves
 * "an approved member asked moments ago", and the client re-mints
 * transparently (acquireRecordingPass) — but long enough to cover a
 * listing plus a few downloads without a round-trip between each.
 */
export const RECORDING_PASS_TTL_SECONDS = 120;

/**
 * How much remaining life a cached pass needs to be presented instead of
 * re-minted (capabilityFresh): the request must still verify after the
 * network hop plus modest clock skew between the module host's clock
 * (which stamped exp) and the Worker's (which checks it).
 */
const CAPABILITY_REUSE_MARGIN_SECONDS = 15;

// ── SHA-256 (FIPS 180-4), over ASCII strings ────────────────────────────

// The round constants: the fractional parts of the cube roots of the
// first 64 primes, as the spec fixes them.
// biome-ignore format: the spec's constant table reads as a table
const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/** The message padded to 512-bit blocks (length in bits appended, big-endian). */
function paddedBlocks(bytes: number[]): number[] {
  const padded = [...bytes, 0x80];
  while (padded.length % 64 !== 56) padded.push(0);
  // Message lengths here are far below 2^32 bits, so the high word is 0.
  const bitLength = bytes.length * 8;
  padded.push(0, 0, 0, 0);
  padded.push(
    (bitLength >>> 24) & 0xff,
    (bitLength >>> 16) & 0xff,
    (bitLength >>> 8) & 0xff,
    bitLength & 0xff,
  );
  return padded;
}

/** One block's 64-entry message schedule (the W expansion). */
function messageSchedule(padded: number[], block: number): number[] {
  const w: number[] = [];
  for (let t = 0; t < 16; t += 1) {
    const i = block + t * 4;
    w.push(
      (((padded[i] ?? 0) << 24) |
        ((padded[i + 1] ?? 0) << 16) |
        ((padded[i + 2] ?? 0) << 8) |
        (padded[i + 3] ?? 0)) >>>
        0,
    );
  }
  for (let t = 16; t < 64; t += 1) {
    const w15 = w[t - 15] ?? 0;
    const w2 = w[t - 2] ?? 0;
    const s0 = (rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3)) >>> 0;
    const s1 = (rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10)) >>> 0;
    w.push((((w[t - 16] ?? 0) + s0 + (w[t - 7] ?? 0) + s1) & 0xffffffff) >>> 0);
  }
  return w;
}

function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

/** One block's compression rounds over the running hash state (in place). */
function compressBlock(state: number[], w: number[]): void {
  let [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0] = state;
  for (let t = 0; t < 64; t += 1) {
    const s1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
    const ch = ((e & f) ^ (~e & g)) >>> 0;
    const t1 = (h + s1 + ch + (K[t] ?? 0) + (w[t] ?? 0)) >>> 0;
    const s0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
    const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
    const t2 = (s0 + maj) >>> 0;
    h = g;
    g = f;
    f = e;
    e = (d + t1) >>> 0;
    d = c;
    c = b;
    b = a;
    a = (t1 + t2) >>> 0;
  }
  const round = [a, b, c, d, e, f, g, h];
  for (let i = 0; i < 8; i += 1)
    state[i] = (((state[i] ?? 0) + (round[i] ?? 0)) & 0xffffffff) >>> 0;
}

/** SHA-256 over a byte array, as a 32-entry byte array. */
function sha256Bytes(bytes: number[]): number[] {
  // The initial hash values: fractional parts of the square roots of the
  // first 8 primes.
  const state = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const padded = paddedBlocks(bytes);
  for (let block = 0; block < padded.length; block += 64) {
    compressBlock(state, messageSchedule(padded, block));
  }
  const digest: number[] = [];
  for (const word of state) {
    digest.push((word >>> 24) & 0xff, (word >>> 16) & 0xff, (word >>> 8) & 0xff, word & 0xff);
  }
  return digest;
}

/** The bytes of an ASCII string, refusing anything outside ASCII. */
function asciiBytes(text: string): number[] | undefined {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code > 0x7f) return undefined;
    bytes.push(code);
  }
  return bytes;
}

function bytesToHex(bytes: number[]): string {
  return bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * HMAC-SHA-256 (RFC 2104) over ASCII strings, as lowercase hex — the one
 * primitive both anchor directions share (see the file header), exported
 * so the future Worker→module relay verifies its payloads with the exact
 * function that signs the recording passes. Undefined when either input
 * is not ASCII: the anchor secret and every payload this project signs
 * are hex/digits/kebab words by construction, so a non-ASCII input is a
 * caller bug surfaced rather than silently mis-encoded.
 */
export function hmacSha256Hex(secret: string, message: string): string | undefined {
  const keyBytes = asciiBytes(secret);
  const messageBytes = asciiBytes(message);
  if (keyBytes === undefined || messageBytes === undefined) return undefined;
  const key = keyBytes.length > 64 ? sha256Bytes(keyBytes) : keyBytes;
  const ipad: number[] = [];
  const opad: number[] = [];
  for (let i = 0; i < 64; i += 1) {
    ipad.push((key[i] ?? 0) ^ 0x36);
    opad.push((key[i] ?? 0) ^ 0x5c);
  }
  return bytesToHex(sha256Bytes([...opad, ...sha256Bytes([...ipad, ...messageBytes])]));
}

// ── The capability format ───────────────────────────────────────────────

/**
 * What one capability asserts, before it is signed. `subjectHex` is the
 * holder's SpacetimeDB Identity hex (the same key the module's rows use);
 * `expSeconds` is a Unix timestamp stamped from the module host's clock.
 */
export interface CapabilityClaims {
  scope: string;
  subjectHex: string;
  expSeconds: number;
}

/** The signed prefix of one capability — what the MAC covers. */
function capabilityPayload(claims: CapabilityClaims): string {
  return `v1:${claims.scope}:${claims.subjectHex}:${claims.expSeconds}`;
}

/** The vocabulary shapes a capability's fields must keep (no delimiters). */
function claimsWellFormed(claims: CapabilityClaims): boolean {
  return (
    /^[a-z][a-z-]*$/.test(claims.scope) &&
    /^[0-9a-f]+$/.test(claims.subjectHex) &&
    Number.isInteger(claims.expSeconds) &&
    claims.expSeconds > 0
  );
}

/**
 * Mints one signed capability: `v1:{scope}:{subjectHex}:{exp}:{mac}`, or
 * undefined when the claims break the format's own vocabulary (hex
 * subject, kebab scope — nothing a delimiter could hide in) or the
 * secret is unusable. The caller (the module's minting reducer) treats
 * undefined as a refusal; it cannot happen through the reducer's own
 * inputs, which are the sender's identity and the server clock.
 */
export function mintCapability(claims: CapabilityClaims, secret: string): string | undefined {
  if (!claimsWellFormed(claims) || secret === '') return undefined;
  const payload = capabilityPayload(claims);
  const mac = hmacSha256Hex(secret, payload);
  return mac === undefined ? undefined : `${payload}:${mac}`;
}

/** Constant-time equality over same-alphabet strings (MAC comparison). */
function macEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The parsed-but-unverified fields of one capability token. */
function parseCapability(token: string): (CapabilityClaims & { mac: string }) | undefined {
  const parts = token.split(':');
  if (parts.length !== 5 || parts[0] !== 'v1') return undefined;
  const [, scope = '', subjectHex = '', expText = '', mac = ''] = parts;
  if (!/^\d{1,15}$/.test(expText) || !/^[0-9a-f]{64}$/.test(mac)) return undefined;
  const claims = { scope, subjectHex, expSeconds: Number(expText) };
  return claimsWellFormed(claims) ? { ...claims, mac } : undefined;
}

/**
 * Verifies one capability against the accepted secrets and returns its
 * subject (the holder's Identity hex), or undefined for anything
 * unverifiable — malformed, wrong scope, expired, or signed by no
 * accepted secret. `secrets` is a LIST for rotation: the Worker accepts
 * old+new while the anchor flips (README「通話 API Worker」), and an
 * empty list verifies nothing (an unprovisioned anchor fails closed).
 */
export function verifiedCapabilitySubject(
  token: string,
  scope: string,
  secrets: readonly string[],
  nowSeconds: number,
): string | undefined {
  const parsed = parseCapability(token);
  if (parsed === undefined || parsed.scope !== scope || parsed.expSeconds <= nowSeconds) {
    return undefined;
  }
  const payload = capabilityPayload(parsed);
  for (const secret of secrets) {
    if (secret === '') continue;
    const mac = hmacSha256Hex(secret, payload);
    if (mac !== undefined && macEquals(mac, parsed.mac)) return parsed.subjectHex;
  }
  return undefined;
}

/**
 * Whether a cached capability still has enough life to present instead
 * of re-minting (the client-side reuse rule — see
 * CAPABILITY_REUSE_MARGIN_SECONDS). False for anything unparseable, so a
 * garbage cache entry re-mints rather than being sent.
 */
export function capabilityFresh(token: string, nowSeconds: number): boolean {
  const parsed = parseCapability(token);
  return parsed !== undefined && parsed.expSeconds - CAPABILITY_REUSE_MARGIN_SECONDS > nowSeconds;
}
