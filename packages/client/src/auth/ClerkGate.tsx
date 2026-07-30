// fallow-ignore-file coverage-gaps -- Clerk-bound React components; need a loaded Clerk instance and a DOM, and no DOM test environment is configured
import { ClerkProvider, Show, SignInButton, UserButton, useAuth } from '@clerk/react';
import type { CSSProperties, ReactNode } from 'react';

const headerStyle: CSSProperties = {
  position: 'absolute',
  top: 12,
  right: 12,
  zIndex: 10,
  font: '13px sans-serif',
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
 */
function AuthBoundary({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) return null;
  return (
    <>
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
    </>
  );
}

/**
 * Wraps the app with Clerk when a publishable key is configured; without one
 * (CI builds, contributors without the key) the app runs guest-only exactly
 * as before.
 */
export function ClerkGate({ children }: { children: ReactNode }) {
  const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
  if (!publishableKey) return children;
  return (
    <ClerkProvider publishableKey={publishableKey}>
      <AuthBoundary>{children}</AuthBoundary>
    </ClerkProvider>
  );
}
