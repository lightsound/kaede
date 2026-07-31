// fallow-ignore-file coverage-gaps -- a React component that mounts the canvas and renders connection status; needs a DOM, and no DOM test environment is configured
import { membershipPrompt } from '@maple/shared';
import { type CSSProperties, useContext, useEffect, useRef, useState } from 'react';
import { AuthSessionContext } from './auth.package';
import { createGameApp, type GameApp } from './game.package';
import { type ConnectionStatus, type Net, type SpaceView, startNet } from './net.package';
import { RenameControl } from './profile.package';
import { AdminSection, AdmissionOverlay, ApplyBanner } from './space.package';
import { UI_FONT, UI_GOLD_BORDER, UI_PANEL_BG, UI_TEXT_COLOR } from './theme';

const STATUS_MESSAGES: Record<Exclude<ConnectionStatus, 'connected'>, string> = {
  connecting: 'サーバーに接続中…',
  reconnecting: '接続が切れました。再接続しています…',
};

const overlayStyle: CSSProperties = {
  position: 'absolute',
  top: 12,
  left: '50%',
  transform: 'translateX(-50%)',
  padding: '6px 14px',
  borderRadius: 999,
  background: UI_PANEL_BG,
  border: UI_GOLD_BORDER,
  color: UI_TEXT_COLOR,
  font: UI_FONT,
  whiteSpace: 'nowrap',
  pointerEvents: 'none',
};

export function App() {
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  // The authoritative display name from the own player row; undefined
  // whenever no row is known to exist (before the first spawn, during a
  // reconnect, after a retention sweep — see startNet's onOwnName contract).
  // While undefined a rename has nowhere to land (the server would refuse it
  // as no-target), so the form stays disabled.
  const [ownName, setOwnName] = useState<string>();
  // Everything membership-related (own admission, roster, guest setting),
  // published by the net stack on every space_member / space_setting change;
  // undefined until the first session reports. Held as one value so the
  // overlays and the admin panel can never disagree about the same instant.
  const [space, setSpace] = useState<SpaceView>();
  const session = useContext(AuthSessionContext);
  // The one handle on the net stack: created inside the effect, disposed by
  // its cleanup, read by the name form at submit time. A ref rather than
  // state because nothing needs to re-render when it changes.
  const netRef = useRef<Net>(undefined);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let game: GameApp | undefined;
    let cancelled = false;

    void (async () => {
      const created = await createGameApp(host);
      // The effect may have been torn down (StrictMode double-invoke) while we
      // were awaiting init; if so, dispose immediately and never mount.
      if (cancelled) {
        created.destroy();
        return;
      }
      game = created;
      netRef.current = startNet(created, setStatus, session.getToken, setOwnName, setSpace);
    })();

    return () => {
      cancelled = true;
      netRef.current?.dispose();
      netRef.current = undefined;
      game?.destroy();
    };
  }, [session]);

  // The admission notice and the admin panel gate themselves on `connected`:
  // while disconnected the subscribed rows are stale, so the connection
  // overlay speaks and the rest hides until the next session republishes.
  const connected = status === 'connected';
  const admission = space?.admission;
  const self = space?.self;
  // Whether to offer this client the membership application (join is an
  // explicit act — see membershipPrompt): as a button on the blocking
  // notice, or as a banner while walking around under the guest rules.
  const prompt = membershipPrompt({ signedIn: session.signedIn, membership: self });
  const apply = () => netRef.current?.applyForMembership();

  return (
    <div style={{ position: 'relative' }}>
      <div ref={hostRef} />
      <AdmissionOverlay
        connected={connected}
        admission={admission}
        prompt={prompt}
        onApply={apply}
      />
      {status !== 'connected' && <div style={overlayStyle}>{STATUS_MESSAGES[status]}</div>}
      <ApplyBanner connected={connected} admission={admission} prompt={prompt} onApply={apply} />
      <RenameControl
        connected={connected}
        ownName={ownName}
        self={self}
        onSubmit={(name) => netRef.current?.setDisplayName(name)}
      />
      <AdminSection
        connected={connected}
        space={space}
        onMemberAction={(action, member) => netRef.current?.memberAction(action, member.identity)}
        onGuestsAllowedChange={(allowed) => netRef.current?.setGuestsAllowed(allowed)}
      />
    </div>
  );
}
