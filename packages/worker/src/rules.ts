// The pure rules of the call API Worker — routing, CORS origin matching,
// participant naming, token dispatch, guest-claims vetting, and the
// recording rules (member-only routes, the R2 listing parse, the webhook
// event summary) — split from the fetch wiring (index.ts) so they are
// unit-testable (the @kaede/shared convention applied inside this
// workspace: the wiring stays a thin untestable shell).
import {
  CAPABILITY_SCOPE_RECORDING,
  isMeetingIdLike,
  isRecordingFileNameLike,
  normalizeDisplayName,
  verifiedCapabilitySubject,
} from '@kaede/shared';
import { decodeJwt } from 'jose';

/**
 * What one request asks of the call API:
 * - `provision`: create a meeting at the provider (the 通話開始 half —
 *   the caller then binds it to its group via the register_group_call
 *   reducer, which is the part this Worker has no authority over).
 * - `mint`: issue a participant token for an existing meeting (the 参加
 *   half — knowing the meeting id IS the authorization to join, see the
 *   group_call table comment in the server).
 * - `record-start` / `record-stop`: cloud recording control (増分④ — the
 *   provider secret AND the R2 upload credentials live here, so neither
 *   can be a client call).
 * - `recordings-list` / `recording-download`: the finished recordings in
 *   the R2 bucket, and a short-lived presigned URL for one of them.
 */
export type CallRoute =
  | { kind: 'provision' }
  | { kind: 'mint'; meetingId: string }
  | { kind: 'record-start'; meetingId: string }
  | { kind: 'record-stop'; meetingId: string }
  | { kind: 'recordings-list' }
  | { kind: 'recording-download'; fileName: string };

/**
 * Whether a route is offered to MEMBERS only (the 増分④ recording
 * authority: 録画の開始/停止・一覧・DL は承認済みメンバー限定 — ROADMAP).
 * The call routes stay open to guests (増分② — guests start, join and
 * screen-share like members); everything recording is member-gated,
 * enforced against the VERIFIED caller kind, so the UI's hidden toggles
 * stay cosmetic.
 */
export function routeIsMemberOnly(route: CallRoute): boolean {
  return route.kind !== 'provision' && route.kind !== 'mint';
}

/**
 * The vetted meeting id of one `/calls/meetings/{id}/{tail}` path, or
 * undefined when the path is not that shape. String slicing rather than a
 * built regex: `tail` is always a literal, but a constructed RegExp reads
 * as a ReDoS candidate to static analysis, and the id's own shape rule
 * (isMeetingIdLike — which admits no slash) already does the vetting.
 */
function meetingSegment(pathname: string, tail: string): string | undefined {
  const prefix = '/calls/meetings/';
  const suffix = `/${tail}`;
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) return undefined;
  const id = pathname.slice(prefix.length, pathname.length - suffix.length);
  return isMeetingIdLike(id) ? id : undefined;
}

/**
 * Routes one request, or undefined for anything this API does not serve.
 * Writes are POSTs; the recording reads (list, download URL) are GETs.
 * The meeting-id and file-name segments are vetted with the same shape
 * rules the reducers apply (isMeetingIdLike / isRecordingFileNameLike), so
 * malformed input 404s here instead of reaching the provider as a mangled
 * URL — and, for the file name, before it could ever name an R2 key
 * outside the recordings prefix.
 */
export function routeCallRequest(method: string, pathname: string): CallRoute | undefined {
  if (method === 'GET') return routeRecordingRead(pathname);
  if (method !== 'POST') return undefined;
  if (pathname === '/calls/meetings') return { kind: 'provision' };
  const mint = meetingSegment(pathname, 'participants');
  if (mint !== undefined) return { kind: 'mint', meetingId: mint };
  const start = meetingSegment(pathname, 'recordings');
  if (start !== undefined) return { kind: 'record-start', meetingId: start };
  const stop = meetingSegment(pathname, 'recordings/stop');
  if (stop !== undefined) return { kind: 'record-stop', meetingId: stop };
  return undefined;
}

/** The GET half of the routing table — split to stay under the CRAP budget. */
function routeRecordingRead(pathname: string): CallRoute | undefined {
  if (pathname === '/calls/recordings') return { kind: 'recordings-list' };
  const match = /^\/calls\/recordings\/([^/]+)\/download-url$/.exec(pathname);
  if (match?.[1] !== undefined && isRecordingFileNameLike(match[1])) {
    return { kind: 'recording-download', fileName: match[1] };
  }
  return undefined;
}

/**
 * Where recordings live inside the bucket: the storage_config `path` the
 * start call sends, the prefix the listing asks for, and the key prefix
 * the download presigns under — one constant so they cannot drift.
 */
export const RECORDINGS_PREFIX = 'recordings';

/** The full R2 object key of one recording (its provider-named basename). */
export function recordingObjectKey(fileName: string): string {
  return `${RECORDINGS_PREFIX}/${fileName}`;
}

/** One finished recording, as the list route reports it. */
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
 * workerd has no DOMParser, and the three fields ride fixed tags inside
 * each <Contents> block, so a scoped regex is the whole parser). Keys
 * outside the recordings prefix or not shaped like a provider-named
 * recording are skipped: the bucket may hold other objects, and the list
 * only ever serves what the download route would accept.
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

/**
 * The loggable summary of one webhook delivery (the payload shape the
 * 増分0 spike and the provider docs fix: recording.statusUpdate carries a
 * `recording` object). Pure so the interesting rule — never echo the
 * whole payload, whose UPLOADED form carries download URLs — is testable;
 * undefined for bodies that are not a recording event (logged as such).
 */
export function summarizeRecordingEvent(
  body: unknown,
): { event: string; recordingId: string; status: string; fileName: string; error: string } | null {
  if (typeof body !== 'object' || body === null) return null;
  const record = body as Record<string, unknown>;
  if (typeof record.event !== 'string') return null;
  const recording = (record.recording ?? {}) as Record<string, unknown>;
  const field = (value: unknown) => (typeof value === 'string' ? value : '');
  return {
    event: record.event,
    recordingId: field(recording.id),
    status: field(recording.status),
    fileName: field(recording.outputFileName),
    error: field(recording.errMessage),
  };
}

/**
 * The header a recording pass rides in (ROADMAP Phase 4 増分⑤). Its own
 * header rather than a second bearer: the Authorization slot already
 * carries the caller's identity credential (Clerk JWT), and the pass is
 * an ADDITIONAL claim — "an approved member, minted moments ago by the
 * module" — presented alongside it. The preflight allow-list must name
 * it (index.ts).
 */
export const RECORDING_PASS_HEADER = 'x-recording-pass';

/**
 * The subject of a verified recording pass, or undefined for anything the
 * member-only routes must refuse: a missing header, a malformed/expired/
 * mis-scoped pass, a signature no accepted secret produced — or an EMPTY
 * secret list, which is the unprovisioned anchor failing closed (the
 * worker_anchor table comment in the server). `secretsRaw` is the
 * RECORDING_PASS_SECRETS binding: comma-separated accepted secrets, a
 * LIST so rotation can hold old+new while the module's anchor flips
 * (README「通話 API Worker」). The verification itself is the shared
 * verifiedCapabilitySubject — the exact code the module signs with, so
 * the two sides cannot disagree on the format.
 */
export function recordingPassSubject(
  pass: string | null,
  secretsRaw: string,
  nowSeconds: number,
): string | undefined {
  if (pass === null || pass === '') return undefined;
  const secrets = secretsRaw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  return verifiedCapabilitySubject(pass, CAPABILITY_SCOPE_RECORDING, secrets, nowSeconds);
}

/**
 * The origin to echo in Access-Control-Allow-Origin, or undefined to send
 * no CORS grant. `allowlist` is the comma-separated ALLOWED_ORIGINS
 * binding (exact-match entries, no wildcards — the client origins are a
 * short fixed set: the custom domain, the workers.dev URL, local dev).
 * A null origin (same-origin requests, curl) needs no grant.
 */
export function allowedOrigin(origin: string | null, allowlist: string): string | undefined {
  if (origin === null) return undefined;
  const allowed = allowlist.split(',').map((entry) => entry.trim());
  return allowed.includes(origin) ? origin : undefined;
}

/**
 * The participant name a mint request carries, normalized under the same
 * rules as every kaede display name (NFC, whitespace collapsing, length
 * cap — normalizeDisplayName). The name is what other call participants
 * see on the tile; it is client-claimed, which is the trust level display
 * names already have in kaede (set_display_name is self-service), so
 * normalization is about well-formedness, not identity. An absent or
 * unusable name falls back rather than refusing: a call join must not
 * fail over a cosmetic string (the fallback says 参加者, not メンバー —
 * guests mint too since 増分②).
 */
export function participantNameFrom(body: unknown): string {
  const raw =
    typeof body === 'object' && body !== null && 'name' in body && typeof body.name === 'string'
      ? body.name
      : '';
  const verdict = normalizeDisplayName(raw);
  return verdict.ok && verdict.name !== '' ? verdict.name : '参加者';
}

/** The bearer credential in an Authorization header, or undefined. */
export function bearerTokenFrom(authorization: string | null): string | undefined {
  if (!authorization?.startsWith('Bearer ')) return undefined;
  const token = authorization.slice('Bearer '.length);
  return token === '' ? undefined : token;
}

/**
 * The token's `iss` claim read WITHOUT verifying anything — only usable
 * to pick which verifier to hand the token to (callerKindOf below); each
 * verifier then re-reads every claim from a signature-checked payload, so
 * a forged issuer buys an attacker nothing but the wrong refusal.
 */
export function unverifiedIssuerOf(token: string): string | undefined {
  try {
    const issuer = decodeJwt(token).iss;
    return typeof issuer === 'string' ? issuer : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The SpacetimeDB host issuers whose guest tokens this API accepts — the
 * Worker-side mirror of the module's connection policy (connectionPolicyFor
 * in packages/server: keep the two lists aligned). `localhost` is what both
 * the local standalone AND Maincloud stamp on host-issued tokens today
 * (live-probed 2026-08-05 — Maincloud's own issuer changed from the
 * auth.spacetimedb.com the module observed in 2026-08; both stay
 * registered, like the module's policy). The claim only picks the
 * verifier: trust comes from the signature check against
 * SPACETIME_HOST_URL's public key (spacetime.ts), so a token from any
 * OTHER SpacetimeDB host fails verification regardless of its issuer.
 */
const SPACETIME_GUEST_ISSUERS = ['localhost', 'https://auth.spacetimedb.com'];

/** The audience SpacetimeDB hosts stamp on their own tokens (live-probed). */
const SPACETIME_GUEST_AUDIENCE = 'spacetimedb';

/**
 * Which trust domain a presented token claims to belong to: the Clerk
 * member path (JWKS + audience, clerk.ts) or the SpacetimeDB guest path
 * (host public key, spacetime.ts — the 増分② lift of the members-only
 * cut). Undefined for any other issuer: no verifier would accept it, so
 * the request 401s without a network round-trip.
 */
export function callerKindOf(
  issuer: string | undefined,
  clerkIssuer: string,
): 'member' | 'guest' | undefined {
  if (issuer === undefined) return undefined;
  if (issuer === clerkIssuer) return 'member';
  if (SPACETIME_GUEST_ISSUERS.includes(issuer)) return 'guest';
  return undefined;
}

/**
 * The guest subject from a SIGNATURE-VERIFIED SpacetimeDB token payload,
 * or undefined for claims we do not accept. Manual claim checks because
 * the host stamps `exp: null` (a non-expiring token — live-probed
 * 2026-08-05), which jose's own claims validation refuses as malformed:
 * issuer in the registered set, the host's audience, an exp that is
 * absent/null (never expires) or still in the future. The subject is the
 * `hex_identity` claim — the SpacetimeDB Identity hex, the same key the
 * module's player rows use, recorded provider-side as
 * custom_participant_id (the Clerk-subject rule applied to guests).
 */
export function guestSubjectFrom(claims: unknown, nowSeconds: number): string | undefined {
  if (typeof claims !== 'object' || claims === null) return undefined;
  const record = claims as Record<string, unknown>;
  if (typeof record.iss !== 'string' || !SPACETIME_GUEST_ISSUERS.includes(record.iss)) {
    return undefined;
  }
  const audiences = Array.isArray(record.aud) ? record.aud : [record.aud];
  if (!audiences.includes(SPACETIME_GUEST_AUDIENCE)) return undefined;
  const exp = record.exp ?? null;
  if (exp !== null && (typeof exp !== 'number' || exp <= nowSeconds)) return undefined;
  const subject = record.hex_identity;
  return typeof subject === 'string' && subject !== '' ? subject : undefined;
}
