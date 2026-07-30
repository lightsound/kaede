// fallow-ignore-file coverage-gaps -- a React component that mounts the canvas and renders connection status; needs a DOM, and no DOM test environment is configured
import { type CSSProperties, useContext, useEffect, useRef, useState } from 'react';
import { AuthTokenContext } from './auth/AuthTokenContext';
import { createGameApp, type GameApp } from './game/GameApp';
import { type ConnectionStatus, type Net, startNet } from './net/sync';

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
  background: 'rgba(11, 13, 18, 0.85)',
  border: '1px solid rgba(216, 166, 87, 0.6)',
  color: '#eceff4',
  font: '13px sans-serif',
  whiteSpace: 'nowrap',
  pointerEvents: 'none',
};

export function App() {
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const getAuthToken = useContext(AuthTokenContext);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let game: GameApp | undefined;
    let net: Net | undefined;
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
      net = startNet(created, setStatus, getAuthToken);
    })();

    return () => {
      cancelled = true;
      net?.dispose();
      game?.destroy();
    };
  }, [getAuthToken]);

  return (
    <div style={{ position: 'relative' }}>
      <div ref={hostRef} />
      {status !== 'connected' && <div style={overlayStyle}>{STATUS_MESSAGES[status]}</div>}
    </div>
  );
}
