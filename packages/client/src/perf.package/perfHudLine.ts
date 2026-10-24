// The dev-only perf overlay's readout (PerfHud.tsx): plain arithmetic over
// one world snapshot and the player-row update counter, kept out of the
// component so it is unit-tested.
import type { E2EWorldSnapshot } from '@kaede/shared';

export function perSecond(delta: number, dt: number): number {
  if (dt <= 0) return 0;
  return delta / dt;
}

function xSpreadPx(xs: number[]): number {
  if (xs.length === 0) return 0;
  return Math.max(...xs) - Math.min(...xs);
}

export function perfHudLine(snap: E2EWorldSnapshot, updateRate: number): string {
  return [
    `FPS        ${snap.fps.toFixed(0)}`,
    `remotes    ${snap.remotePlayers.length}`,
    `row upd/s  ${updateRate.toFixed(0)}`,
    `x-spread   ${xSpreadPx(snap.remotePlayers.map((p) => p.x)).toFixed(0)}px`,
  ].join('\n');
}
