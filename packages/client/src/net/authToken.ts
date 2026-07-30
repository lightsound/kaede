// fallow-ignore-file coverage-gaps -- thin wrapper over Clerk's browser SDK; needs a loaded Clerk instance, not a unit test
import { getToken } from '@clerk/react';
import type { AuthTokenGetter } from './connection';

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
export const guestToken: AuthTokenGetter = () => Promise.resolve(undefined);

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
export const memberToken: AuthTokenGetter = async () => {
  // skipCache: a token minted seconds ago may expire before the WebSocket
  // handshake completes on a slow reconnect; always mint fresh.
  const token = await getToken({ template: CLERK_JWT_TEMPLATE, skipCache: true });
  if (!token) throw new Error('Clerk reports a signed-in user but returned no session token');
  return token;
};
