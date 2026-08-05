// The pure rules of the call API Worker — routing, CORS origin matching,
// participant naming, token dispatch and guest-claims vetting — split from
// the fetch wiring (index.ts) so they are unit-testable (the @kaede/shared
// convention applied inside this workspace: the wiring stays a thin
// untestable shell).
import { isMeetingIdLike, normalizeDisplayName } from '@kaede/shared';
import { decodeJwt } from 'jose';

/**
 * What one request asks of the call API:
 * - `provision`: create a meeting at the provider (the 通話開始 half —
 *   the caller then binds it to its group via the register_group_call
 *   reducer, which is the part this Worker has no authority over).
 * - `mint`: issue a participant token for an existing meeting (the 参加
 *   half — knowing the meeting id IS the authorization to join, see the
 *   group_call table comment in the server).
 */
export type CallRoute = { kind: 'provision' } | { kind: 'mint'; meetingId: string };

/**
 * Routes one request, or undefined for anything this API does not serve.
 * POST-only: both operations create provider-side state. The meeting id
 * segment is vetted with the same shape rule the reducer applies
 * (isMeetingIdLike), so a malformed id 404s here instead of reaching the
 * provider as a mangled URL.
 */
export function routeCallRequest(method: string, pathname: string): CallRoute | undefined {
  if (method !== 'POST') return undefined;
  if (pathname === '/calls/meetings') return { kind: 'provision' };
  const match = /^\/calls\/meetings\/([^/]+)\/participants$/.exec(pathname);
  if (match?.[1] !== undefined && isMeetingIdLike(match[1])) {
    return { kind: 'mint', meetingId: match[1] };
  }
  return undefined;
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
