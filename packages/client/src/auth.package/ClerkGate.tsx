// fallow-ignore-file coverage-gaps -- Clerk-bound React components; need a loaded Clerk instance and a DOM, and no DOM test environment is configured
import { jaJP } from '@clerk/localizations';
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
import { type CSSProperties, type ReactNode, useEffect } from 'react';
import { identifyMember, resetIdentity } from '../telemetry.package';
import { UI_FONT, UI_GOLD_BORDER, UI_PANEL_BG, UI_TEXT_COLOR } from '../theme';
import { AuthSessionContext } from './AuthSessionContext';
import { guestSession, memberSession } from './authToken';

const headerStyle: CSSProperties = {
  position: 'absolute',
  top: 12,
  right: 12,
  zIndex: 10,
  font: UI_FONT,
};

const noticeStyle: CSSProperties = {
  ...headerStyle,
  padding: '6px 14px',
  borderRadius: 999,
  background: UI_PANEL_BG,
  border: UI_GOLD_BORDER,
  color: UI_TEXT_COLOR,
  pointerEvents: 'none',
};

const signInButtonStyle: CSSProperties = {
  padding: '6px 14px',
  borderRadius: 999,
  background: UI_PANEL_BG,
  border: UI_GOLD_BORDER,
  color: UI_TEXT_COLOR,
  cursor: 'pointer',
};

/**
 * Remounts children whenever the signed-in state flips. A SpacetimeDB
 * connection is bound to one identity for its lifetime, so switching between
 * the guest identity and a Clerk identity requires tearing the whole net
 * stack down and reconnecting with the other token.
 *
 * The session (token source + member flag) is provided together with the
 * tree it belongs to: the member tree always demands a Clerk token (a failed
 * mint fails the connect and retries — never a silent guest demotion) and
 * the guest tree never offers one (a stale token minted during sign-out
 * can't leak in).
 *
 * Mount only under `<ClerkLoaded>`: `isSignedIn` is undefined until Clerk has
 * loaded, and would silently read as "guest" here.
 */
function AuthBoundary({ children }: { children: ReactNode }) {
  const { isSignedIn, userId } = useAuth();

  // エラー監視の distinct_id を Clerk user ID に揃える(ADR §8.2-D)。
  // identify はサインイン済みツリーだけが呼び、匿名(ゲスト・サインアウト)
  // では決して呼ばない — identified events は匿名の最大4倍単価。reset は
  // identify 済みのときだけ効く(telemetry 側でガード)ので、ゲストの匿名
  // distinct_id をマウントのたびに回転させることはない。
  useEffect(() => {
    if (isSignedIn && userId) identifyMember(userId);
    else resetIdentity();
  }, [isSignedIn, userId]);

  return (
    <AuthSessionContext.Provider value={isSignedIn ? memberSession : guestSession}>
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
    </AuthSessionContext.Provider>
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
    // Vendor UI dictionary (not Paraglide): same pattern as RealtimeKit's
    // useLanguage partial dict — our strings stay in Paraglide; Clerk's stay
    // in @clerk/localizations (ROADMAP Phase 4.5 増分①).
    <ClerkProvider publishableKey={publishableKey} localization={jaJP}>
      <ClerkLoading>
        <div style={noticeStyle}>ログイン状態を確認しています…</div>
      </ClerkLoading>
      <ClerkLoaded>
        <AuthBoundary>{children}</AuthBoundary>
      </ClerkLoaded>
      <ClerkFailed>
        <div style={noticeStyle}>ログイン機能を読み込めませんでした。ゲストとして参加します。</div>
        {children}
      </ClerkFailed>
    </ClerkProvider>
  );
}
