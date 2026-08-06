// The S3 (R2) access rules of the recording flow (ROADMAP Phase 4 増分④→⑥):
// SigV4 request signing — the bucket listing's Authorization headers and the
// download URL presigning — plus the ListObjectsV2 response parse. Since 増分⑥
// the caller is the module's recording procedures (packages/server), which is
// exactly why the signing is implemented in plain TypeScript: the SpacetimeDB
// module host exposes no WebCrypto (and crypto.subtle is async anyway, which
// a synchronous procedure cannot await), and R2 offers no header-less read
// path — a presigned URL can ONLY be minted from the S3 credentials.
//
// This file grew out of 増分⑤'s capability.ts (the recording-pass format,
// retired with the trust anchor in 増分⑥): the SHA-256/HMAC core carries
// over unchanged, RFC-vector-tested. Inputs are restricted to ASCII (hex
// identities, bucket/object names, the SigV4 grammar), which keeps the byte
// encoding trivial and unambiguous; a non-ASCII input is a caller bug
// surfaced as undefined rather than silently mis-encoded. No exported type
// here references another file, so the file adds no type-coupling evidence
// edges (the fallow cap, see AGENTS.md).
import { isRecordingFileNameLike } from './zone';

// ── SHA-256 (FIPS 180-4) ────────────────────────────────────────────────

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

/** HMAC-SHA-256 (RFC 2104) over byte arrays — SigV4's key-chaining primitive. */
function hmacBytes(key: number[], message: number[]): number[] {
  const blockKey = key.length > 64 ? sha256Bytes(key) : key;
  const ipad: number[] = [];
  const opad: number[] = [];
  for (let i = 0; i < 64; i += 1) {
    ipad.push((blockKey[i] ?? 0) ^ 0x36);
    opad.push((blockKey[i] ?? 0) ^ 0x5c);
  }
  return sha256Bytes([...opad, ...sha256Bytes([...ipad, ...message])]);
}

/**
 * HMAC-SHA-256 over ASCII strings, as lowercase hex. Exported beyond the
 * SigV4 internals for two standing reasons: the RFC 4231 vectors pin the
 * hash core through it (see the tests), and the planned Clerk webhook
 * intake (svix signatures are HMAC-SHA-256 — VISION 課金行, ROADMAP 増分⑥
 * D1) verifies with this exact primitive. Undefined when either input is
 * not ASCII: a non-ASCII input is a caller bug surfaced rather than
 * silently mis-encoded (the file-header rule).
 */
export function hmacSha256Hex(secret: string, message: string): string | undefined {
  const keyBytes = asciiBytes(secret);
  const messageBytes = asciiBytes(message);
  if (keyBytes === undefined || messageBytes === undefined) return undefined;
  return bytesToHex(hmacBytes(keyBytes, messageBytes));
}

// ── SigV4 request signing (AWS Signature Version 4, for R2's S3 API) ───

/**
 * Percent-encoding as SigV4 canonicalization demands it: everything but
 * the RFC 3986 unreserved set, uppercase hex. encodeURIComponent leaves
 * !'()* bare, so those are re-encoded by hand.
 */
function sigv4Encode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** The canonical URI: each path segment encoded once, '/' preserved. */
function canonicalUri(path: string): string {
  return path
    .split('/')
    .map((segment) => sigv4Encode(segment))
    .join('/');
}

/** The canonical query string: entries sorted by encoded name, then value. */
function canonicalQuery(query: readonly (readonly [string, string])[]): string {
  return query
    .map(([name, value]) => [sigv4Encode(name), sigv4Encode(value)] as const)
    .sort(([an, av], [bn, bv]) => (an < bn ? -1 : an > bn ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
}

/** `nowMs` as the two SigV4 date forms: 20130524T000000Z and 20130524. */
function amzDates(nowMs: number): { amzDate: string; dateStamp: string } {
  const amzDate = `${new Date(nowMs).toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

/** One S3 request to sign. `query` entries arrive unencoded. */
export interface S3Request {
  method: string;
  host: string;
  /** The path-style object path, e.g. `/bucket/recordings/file.mp4`. */
  path: string;
  query: readonly (readonly [string, string])[];
}

/** The R2 S3 credentials (an R2-permitted API token in another form). */
export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * The scope fields the tests vary and R2 fixes: R2's region is the
 * literal 'auto', and everything this project signs is the S3 service.
 */
const S3_SERVICE = 's3';

/** The derived signature over one canonical request (the SigV4 core). */
function sigv4Signature(
  credentials: S3Credentials,
  region: string,
  dateStamp: string,
  amzDate: string,
  canonicalRequest: string,
): string | undefined {
  const requestBytes = asciiBytes(canonicalRequest);
  const secretBytes = asciiBytes(`AWS4${credentials.secretAccessKey}`);
  const scopeBytes = [dateStamp, region, S3_SERVICE, 'aws4_request'].map(asciiBytes);
  if (requestBytes === undefined || secretBytes === undefined) return undefined;
  if (scopeBytes.some((bytes) => bytes === undefined)) return undefined;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    `${dateStamp}/${region}/${S3_SERVICE}/aws4_request`,
    bytesToHex(sha256Bytes(requestBytes)),
  ].join('\n');
  const stringBytes = asciiBytes(stringToSign);
  if (stringBytes === undefined) return undefined;
  let key = secretBytes;
  for (const part of scopeBytes) {
    key = hmacBytes(key, part ?? []);
  }
  return bytesToHex(hmacBytes(key, stringBytes));
}

/**
 * The headers of one SigV4-signed S3 request (the listing's GET): host,
 * x-amz-date, x-amz-content-sha256 (the empty payload — every request this
 * project signs is a body-less read) and the Authorization header carrying
 * the derived signature. `region` is a parameter so the AWS documentation
 * vectors (us-east-1) can pin the implementation the tests cannot reach
 * through R2's fixed 'auto'. Undefined for non-ASCII input (file-header
 * rule).
 */
export function signedS3Headers(
  request: S3Request,
  credentials: S3Credentials,
  nowMs: number,
  region: string,
): Record<string, string> | undefined {
  const { amzDate, dateStamp } = amzDates(nowMs);
  const emptyPayloadHash = bytesToHex(sha256Bytes([]));
  const headers: [string, string][] = [
    ['host', request.host],
    ['x-amz-content-sha256', emptyPayloadHash],
    ['x-amz-date', amzDate],
  ];
  const signedHeaderNames = headers.map(([name]) => name).join(';');
  const canonicalRequest = [
    request.method,
    canonicalUri(request.path),
    canonicalQuery(request.query),
    ...headers.map(([name, value]) => `${name}:${value}`),
    '',
    signedHeaderNames,
    emptyPayloadHash,
  ].join('\n');
  const signature = sigv4Signature(credentials, region, dateStamp, amzDate, canonicalRequest);
  if (signature === undefined) return undefined;
  const credentialScope = `${dateStamp}/${region}/${S3_SERVICE}/aws4_request`;
  return {
    host: request.host,
    'x-amz-content-sha256': emptyPayloadHash,
    'x-amz-date': amzDate,
    authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaderNames}, Signature=${signature}`,
  };
}

/**
 * One presigned S3 GET URL (the download route): the browser fetches it
 * with no headers at all, so every signing input rides the query string
 * and the payload is UNSIGNED-PAYLOAD (the presigning grammar — the AWS
 * documentation vector pins it, see the tests). `request.query` carries
 * the non-auth extras (response-content-disposition); expiry is checked
 * by R2 at request time, not mid-stream. Undefined for non-ASCII input.
 */
export function presignedS3Url(
  request: S3Request,
  credentials: S3Credentials,
  nowMs: number,
  expiresSeconds: number,
  region: string,
): string | undefined {
  const { amzDate, dateStamp } = amzDates(nowMs);
  const credentialScope = `${dateStamp}/${region}/${S3_SERVICE}/aws4_request`;
  const query: (readonly [string, string])[] = [
    ...request.query,
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${credentials.accessKeyId}/${credentialScope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(expiresSeconds)],
    ['X-Amz-SignedHeaders', 'host'],
  ];
  const canonicalRequest = [
    request.method,
    canonicalUri(request.path),
    canonicalQuery(query),
    `host:${request.host}`,
    '',
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const signature = sigv4Signature(credentials, region, dateStamp, amzDate, canonicalRequest);
  if (signature === undefined) return undefined;
  const encoded = canonicalQuery(query);
  return `https://${request.host}${canonicalUri(request.path)}?${encoded}&X-Amz-Signature=${signature}`;
}

// ── The recordings bucket layout and listing parse ─────────────────────

/**
 * Where recordings live inside the bucket: the storage_config `path` the
 * recording start sends the provider, the prefix the listing asks for,
 * and the key prefix downloads presign under — one constant so they
 * cannot drift.
 */
export const RECORDINGS_PREFIX = 'recordings';

/** The full R2 object key of one recording (its provider-named basename). */
export function recordingObjectKey(fileName: string): string {
  return `${RECORDINGS_PREFIX}/${fileName}`;
}

/** One finished recording, as the listing reports it. */
export interface RecordingObject {
  /** The provider-named basename — the call_recording rows' join key. */
  fileName: string;
  /** Object size in bytes. */
  size: number;
  /** The R2 LastModified timestamp (ISO 8601) — when the upload landed. */
  uploadedAt: string;
}

/**
 * The recordings in one S3 ListObjectsV2 response (the XML S3 speaks —
 * neither workerd nor the module host has a DOMParser, and the three
 * fields ride fixed tags inside each <Contents> block, so a scoped regex
 * is the whole parser). Keys outside the recordings prefix or not shaped
 * like a provider-named recording are skipped: the bucket may hold other
 * objects, and the list only ever serves what the download route would
 * accept.
 */
export function parseBucketListing(xml: string): RecordingObject[] {
  const objects: RecordingObject[] = [];
  for (const [, block] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const key = /<Key>([^<]*)<\/Key>/.exec(block ?? '')?.[1];
    const size = /<Size>(\d+)<\/Size>/.exec(block ?? '')?.[1];
    const uploadedAt = /<LastModified>([^<]*)<\/LastModified>/.exec(block ?? '')?.[1];
    if (key === undefined || size === undefined || uploadedAt === undefined) continue;
    const fileName = key.startsWith(`${RECORDINGS_PREFIX}/`)
      ? key.slice(RECORDINGS_PREFIX.length + 1)
      : undefined;
    if (fileName === undefined || !isRecordingFileNameLike(fileName)) continue;
    objects.push({ fileName, size: Number(size), uploadedAt });
  }
  return objects;
}
