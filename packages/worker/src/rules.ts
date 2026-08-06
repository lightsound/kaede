// The pure rules of the call API Worker — routing, CORS origin matching,
// participant naming, token dispatch, guest-claims vetting and webhook
// payload shaping — split from the fetch wiring (index.ts) so they are
// unit-testable (the @kaede/shared convention applied inside this
// workspace: the wiring stays a thin untestable shell).
import { isMeetingIdLike, isRecordingIdLike, normalizeDisplayName } from '@kaede/shared';
import { decodeJwt } from 'jose';
import { type CallRoute, matchCallRoute } from './routes';

export type { CallRoute };

/**
 * Routes one request, or undefined for anything this API does not serve.
 * Meeting / recording id segments are vetted with the same UUID shape the
 * reducers apply (matchCallRoute in routes.ts).
 */
export function routeCallRequest(method: string, pathname: string): CallRoute | undefined {
  return matchCallRoute(method, pathname);
}

/**
 * Whether this route needs a verified kaede identity (Clerk or guest).
 * The webhook is the exception: its trust anchor is rtk-signature.
 */
export function routeNeedsCaller(route: CallRoute): boolean {
  return route.kind !== 'webhook';
}

/**
 * Whether this route is restricted to signed-in members (no guests).
 * Recording start/stop/download are the paid / archive surface — guests
 * may join the call (増分②) but cannot open the recording catalog
 * (ROADMAP 増分④).
 */
export function routeNeedsMember(route: CallRoute): boolean {
  return (
    route.kind === 'startRecording' ||
    route.kind === 'stopRecording' ||
    route.kind === 'downloadRecording'
  );
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

/**
 * The R2 object key prefix for one meeting's recordings. Start Recording
 * passes this as storage_config.path so uploaded files land under a
 * deterministic prefix the webhook can re-derive from meetingId +
 * outputFileName.
 */
export function recordingObjectPrefix(meetingId: string): string {
  return `recordings/${meetingId}`;
}

/** Joins the meeting prefix with a provider output file name. */
export function recordingObjectKey(meetingId: string, outputFileName: string): string {
  const name = outputFileName.replace(/^\/+/, '');
  return `${recordingObjectPrefix(meetingId)}/${name}`;
}

/**
 * Fields the webhook handler needs from a verified
 * recording.statusUpdate body. Undefined when the payload is not that
 * event or is missing required ids — the handler 204s those so RealtimeKit
 * does not retry forever on events we deliberately ignore.
 */
export interface RecordingWebhookFields {
  recordingId: string;
  meetingId: string;
  status: string;
  outputFileName: string;
  startedAtMs: bigint;
  durationSecs: number;
  downloadUrl: string;
}

function stringProp(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

function millisFrom(raw: unknown): bigint {
  if (typeof raw === 'number' && Number.isFinite(raw)) return BigInt(Math.trunc(raw));
  if (typeof raw === 'string' && raw !== '') {
    const asNumber = Date.parse(raw);
    if (Number.isFinite(asNumber)) return BigInt(asNumber);
  }
  return 0n;
}

/**
 * Pulls the recording catalog fields out of a parsed webhook JSON body.
 * Accepts only `recording.statusUpdate`; other events return undefined.
 */
export function recordingWebhookFieldsFrom(body: unknown): RecordingWebhookFields | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const root = body as Record<string, unknown>;
  if (root.event !== 'recording.statusUpdate') return undefined;
  const recording = root.recording;
  if (typeof recording !== 'object' || recording === null) return undefined;
  const rec = recording as Record<string, unknown>;
  const recordingId = stringProp(rec, 'recordingId') || stringProp(rec, 'id');
  const meetingId = stringProp(rec, 'meetingId');
  const status = stringProp(rec, 'status');
  if (!isRecordingIdLike(recordingId) || !isMeetingIdLike(meetingId) || status === '') {
    return undefined;
  }
  const durationRaw = rec.recordingDuration;
  const durationSecs =
    typeof durationRaw === 'number' && Number.isFinite(durationRaw)
      ? Math.max(0, Math.trunc(durationRaw))
      : typeof durationRaw === 'string' && durationRaw !== ''
        ? Math.max(0, Math.trunc(Number(durationRaw)) || 0)
        : 0;
  return {
    recordingId,
    meetingId,
    status,
    outputFileName: stringProp(rec, 'outputFileName'),
    startedAtMs: millisFrom(rec.startedTime),
    durationSecs,
    downloadUrl: stringProp(rec, 'downloadUrl'),
  };
}
