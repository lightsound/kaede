// fallow-ignore-file coverage-gaps -- a bare createContext holder with no behavior of its own; the wiring it enables is exercised via ClerkGate/App, which need a DOM
import { createContext } from 'react';
import { type AuthSession, guestSession } from './authToken';

/**
 * How the mounted tree authenticates its SpacetimeDB connection (and whether
 * it is a signed-in member — see AuthSession). ClerkGate provides the member
 * session while (and only while) the signed-in tree is mounted; everywhere
 * else — signed out, or Clerk not configured at all — the default guest
 * session applies. Deriving the mode from the mounted tree rather than from
 * live Clerk state makes sign-in/sign-out races impossible: the tree and its
 * session change together, atomically, via remount.
 */
export const AuthSessionContext = createContext<AuthSession>(guestSession);
