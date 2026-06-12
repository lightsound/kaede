import { useEffect, useRef } from 'react';
import { createGameApp, type GameApp } from './game/GameApp';

export function App() {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let game: GameApp | undefined;
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
    })();

    return () => {
      cancelled = true;
      game?.destroy();
    };
  }, []);

  return <div ref={hostRef} />;
}
