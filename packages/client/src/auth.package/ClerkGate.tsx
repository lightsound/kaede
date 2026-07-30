// fallow-ignore-file coverage-gaps -- Clerk-bound React components; need a loaded Clerk instance and a DOM, and no DOM test environment is configured
import {
  ClerkFailed,
  ClerkLoaded,
  ClerkLoading,
  ClerkProvider,
  Show,
  SignInButton,
  UserButton,
  useAuth,
} from '@clerk/react';
import type { CSSProperties, ReactNode } from 'react';
import { AuthTokenContext } from './AuthTokenContext';
import { guestToken, memberToken } from './authToken';

const headerStyle: CSSProperties = {
  position: 'absolute',
  top: 12,
  right: 12,
  zIndex: 10,
  font: '13px sans-serif',
};

const noticeStyle: CSSProperties = {
  ...headerStyle,
  padding: '6px 14px',
  borderRadius: 999,
  background: 'rgba(11, 13, 18, 0.85)',
  border: '1px solid rgba(216, 166, 87, 0.6)',
  color: '#eceff4',
  pointerEvents: 'none',
};

const signInButtonStyle: CSSProperties = {
  padding: '6px 14px',
  borderRadius: 999,
  background: 'rgba(11, 13, 18, 0.85)',
  border: '1px solid rgba(216, 166, 87, 0.6)',
  color: '#eceff4',
  cursor: 'pointer',
};

/**
 * Remounts children whenever the signed-in state flips. A SpacetimeDB
 * connection is bound to one identity for its lifetime, so switching between
 * the guest identity and a Clerk identity requires tearing the whole net
 * stack down and reconnecting with the other token.
 *
 * The token source is provided together with the tree it belongs to: the
 * member tree always demands a Clerk token (a failed mint fails the connect
 * and retries — never a silent guest demotion) and the guest tree never
 * offers one (a stale token minted during sign-out can't leak in).
 */
function AuthBoundary({ children }: { children: ReactNode }) {
  const { isSignedIn } = useAuth();
  return (
    <AuthTokenContext.Provider value={isSignedIn ? memberToken : guestToken}>
      <header style={headerStyle}>
        <Show when="signed-out">
          <SignInButton mode="modal">
            <button type="button" style={signInButtonStyle}>
              ログイン
            </button>
          </SignInButton>
        </Show>
        <Show when="signed-in">
          <UserButton />
        </Show>
      </header>
      <div key={isSignedIn ? 'member' : 'guest'}>{children}</div>
    </AuthTokenContext.Provider>
  );
}

/**
 * Wraps the app with Clerk when a publishable key is configured; without one
 * (CI builds, contributors without the key) the app runs guest-only exactly
 * as before.
 *
 * A Clerk that never loads — blocked script, offline, wrong key — must not cost
 * anyone the world: the office stays enterable as a guest, with a notice saying
 * signing in is unavailable, rather than rendering a blank page. Signing in
 * later is a reload away, and the guest tree can never mint a member token.
 */
export function ClerkGate({ children }: { children: ReactNode }) {
  const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
  if (!publishableKey) return children;
  return (
    <ClerkProvider publishableKey={publishableKey}>
      <ClerkLoading>
        <div style={noticeStyle}>ログイン状態を確認しています…</div>
      </ClerkLoading>
      <ClerkLoaded>
        <AuthBoundary>{children}</AuthBoundary>
      </ClerkLoaded>
      <ClerkFailed>
        <div style={noticeStyle}>ログイン機能を読み込めませんでした。ゲストとして参加します。</div>
        <AuthTokenContext.Provider value={guestToken}>{children}</AuthTokenContext.Provider>
      </ClerkFailed>
    </ClerkProvider>
  );
}
