// fallow-ignore-file coverage-gaps -- thin wrapper over Clerk's browser SDK; needs a loaded Clerk instance, not a unit test
import { getToken } from '@clerk/react';
import type { AuthTokenGetter } from '../net.package';

/**
 * The Clerk JWT template used for SpacetimeDB connections. It pins the `aud`
 * claim so the module can verify the token was minted for this app and not
 * repurposed from another Clerk-backed service.
 */
const CLERK_JWT_TEMPLATE = 'spacetimedb';

/**
 * The guest path: connect tokenless and let the connection layer resume this
 * tab's anonymous identity. Also the default when Clerk is not configured.
 */
const guestToken: AuthTokenGetter = () => Promise.resolve(undefined);

/**
 * The member path: mint a fresh Clerk session JWT. Clerk session tokens are
 * short-lived, so this is called anew on every (re)connect attempt — never
 * cache the result (VISION 技術方針).
 *
 * This getter is only ever wired while the member tree is mounted (see
 * ClerkGate), so a missing token is an anomaly (sign-in still settling,
 * expired session mid-mint, misconfigured template) — throwing fails the
 * attempt and retries with backoff. It must NOT fall back to the guest path:
 * the UI would say "logged in" while the world sees the anonymous identity.
 */
const memberToken: AuthTokenGetter = async () => {
  // skipCache: a token minted seconds ago may expire before the WebSocket
  // handshake completes on a slow reconnect; always mint fresh.
  const token = await getToken({ template: CLERK_JWT_TEMPLATE, skipCache: true });
  if (!token) throw new Error('Clerk reports a signed-in user but returned no session token');
  return token;
};

/**
 * How the mounted tree authenticates, and what that means: the token source
 * for SpacetimeDB connections, plus whether this client is a signed-in
 * member — which is what gates the membership-application UI (a guest has no
 * account to hang an application on; see membershipPrompt in @kaede/shared).
 * The two travel together because they must flip together: a token source
 * that says member with a flag that says guest (or vice versa) is exactly
 * the race the remount-based design rules out.
 */
export interface AuthSession {
  readonly getToken: AuthTokenGetter;
  readonly signedIn: boolean;
}

/** Module constants so an unchanged session never re-triggers App's effect. */
export const guestSession: AuthSession = { getToken: guestToken, signedIn: false };
export const memberSession: AuthSession = { getToken: memberToken, signedIn: true };
