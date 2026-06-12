import { useEffect, useRef } from 'react';
import { createGameApp, type GameApp } from './game/GameApp';
import { startNet, type Net } from './net/sync';

export function App() {
  const hostRef = useRef<HTMLDivElement>(null);

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
    })();

    return () => {
      cancelled = true;
      net?.dispose();
      game?.destroy();
    };
  }, []);

  return <div ref={hostRef} />;
}
