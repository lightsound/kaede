// fallow-ignore-file coverage-gaps -- a bare createContext holder with no behavior of its own; the wiring it enables is exercised via ClerkGate/App, which need a DOM
import { createContext } from 'react';
import { guestToken } from '../net/authToken';
import type { AuthTokenGetter } from '../net/connection';

/**
 * How the mounted tree authenticates its SpacetimeDB connection. ClerkGate
 * provides the member getter while (and only while) the signed-in tree is
 * mounted; everywhere else — signed out, or Clerk not configured at all —
 * the default guest getter applies. Deriving the mode from the mounted tree
 * rather than from live Clerk state makes sign-in/sign-out races impossible:
 * the tree and its token source change together, atomically, via remount.
 */
export const AuthTokenContext = createContext<AuthTokenGetter>(guestToken);
