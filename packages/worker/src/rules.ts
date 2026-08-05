// The pure rules of the call API Worker — routing, CORS origin matching,
// participant naming — split from the fetch wiring (index.ts) so they are
// unit-testable (the @kaede/shared convention applied inside this
// workspace: the wiring stays a thin untestable shell).
import { isMeetingIdLike, normalizeDisplayName } from '@kaede/shared';

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
 * fail over a cosmetic string.
 */
export function participantNameFrom(body: unknown): string {
  const raw =
    typeof body === 'object' && body !== null && 'name' in body && typeof body.name === 'string'
      ? body.name
      : '';
  const verdict = normalizeDisplayName(raw);
  return verdict.ok && verdict.name !== '' ? verdict.name : 'メンバー';
}
