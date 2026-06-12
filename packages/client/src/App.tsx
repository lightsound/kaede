import { useEffect, useRef, useState } from 'react';
import { createGameApp, type GameApp } from './game/GameApp';
import { startNet, type Net } from './net/sync';

const NAME_KEY = 'maple.name';
const MAX_NAME = 16;

export function App() {
  const hostRef = useRef<HTMLDivElement>(null);
  const netRef = useRef<Net>(null);

  // Auto-apply a previously chosen name and skip the prompt; only first-time
  // players (no stored name) see the overlay.
  const storedName = localStorage.getItem(NAME_KEY) ?? '';
  const [showOverlay, setShowOverlay] = useState(storedName === '');
  const [draft, setDraft] = useState(storedName);

  useEffect(() => {
    let game: GameApp | undefined;
    let net: Net | undefined;
    let cancelled = false;

    void (async () => {
      const created = await createGameApp(hostRef.current!);
      // The effect may have been torn down (StrictMode double-invoke) while we
      // were awaiting init; if so, dispose immediately and never mount.
      if (cancelled) {
        created.destroy();
        return;
      }
      game = created;
      net = startNet(created);
      netRef.current = net;
      // setName latches until the connection is ready, so it's safe to fire the
      // stored name immediately.
      if (storedName !== '') net.setName(storedName);
    })();

    return () => {
      cancelled = true;
      net?.dispose();
      netRef.current = null;
      game?.destroy();
    };
    // storedName is read once at mount; the overlay drives later name changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function submit() {
    const name = draft.trim();
    if (name === '') return;
    localStorage.setItem(NAME_KEY, name);
    netRef.current?.setName(name);
    setShowOverlay(false);
  }

  return (
    <div ref={hostRef}>
      {showOverlay && (
        <div style={overlayStyle}>
          <div style={panelStyle}>
            <label style={labelStyle} htmlFor="name">
              キャラクター名
            </label>
            <input
              id="name"
              autoFocus
              maxLength={MAX_NAME}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit();
              }}
              style={inputStyle}
            />
            <button onClick={submit} disabled={draft.trim() === ''} style={buttonStyle}>
              ゲームを始める
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'rgba(11, 13, 18, 0.85)',
  zIndex: 10,
};

const panelStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  padding: 24,
  minWidth: 260,
  borderRadius: 8,
  background: '#1b1f2a',
  border: '1px solid #3b4252',
  fontFamily: 'sans-serif',
  color: '#eceff4',
};

const labelStyle: React.CSSProperties = { fontSize: 14 };

const inputStyle: React.CSSProperties = {
  padding: '8px 10px',
  fontSize: 16,
  borderRadius: 4,
  border: '1px solid #3b4252',
  background: '#10131b',
  color: '#eceff4',
};

const buttonStyle: React.CSSProperties = {
  padding: '8px 10px',
  fontSize: 15,
  borderRadius: 4,
  border: 'none',
  background: '#5e81ac',
  color: '#eceff4',
  cursor: 'pointer',
};
