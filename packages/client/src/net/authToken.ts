// fallow-ignore-file coverage-gaps -- thin wrapper over Clerk's browser SDK; needs a loaded Clerk instance, not a unit test
import { getToken } from '@clerk/react';

/**
 * The Clerk JWT template used for SpacetimeDB connections. It pins the `aud`
 * claim so the module can verify the token was minted for this app and not
 * repurposed from another Clerk-backed service.
 */
const CLERK_JWT_TEMPLATE = 'spacetimedb';

/**
 * Fetches a fresh Clerk session JWT for the SpacetimeDB connection, or
 * undefined when Clerk is not configured or nobody is signed in (the guest
 * path). Clerk session tokens are short-lived, so this must be called anew on
 * every (re)connect attempt — never cache the result (VISION 技術方針).
 *
 * A signed-in user whose token mint fails must NOT fall back to the guest
 * path: the UI would say "logged in" while the world sees the anonymous
 * identity. Throwing instead makes the attempt fail and retry with backoff.
 */
export async function getClerkToken(): Promise<string | undefined> {
  if (!import.meta.env.VITE_CLERK_PUBLISHABLE_KEY) return undefined;
  // skipCache: a token minted seconds ago may expire before the WebSocket
  // handshake completes on a slow reconnect; always mint fresh.
  const token = await getToken({ template: CLERK_JWT_TEMPLATE, skipCache: true });
  // getToken() has awaited Clerk's load, so window.Clerk is populated here.
  // The token is only trusted while Clerk still reports a signed-in user:
  // token-without-user is a sign-out race (drop the stale token, go guest),
  // user-without-token is an anomaly (expired session mid-mint, misconfigured
  // template) that must fail the attempt rather than demote to guest.
  const signedIn = (window as { Clerk?: { user?: unknown } }).Clerk?.user != null;
  if (signedIn && !token) {
    throw new Error('Clerk reports a signed-in user but returned no session token');
  }
  return signedIn && token ? token : undefined;
}
