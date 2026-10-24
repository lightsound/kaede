import type { E2EPlayerSnapshot, E2EWorldSnapshot } from '@kaede/shared';
import { describe, expect, it } from 'vitest';
import { perfHudLine, perSecond } from '../src/perf.package/perfHudLine';

function player(x: number): E2EPlayerSnapshot {
  return { x, y: 0, name: 'かえで', pose: 'stand' };
}

function snapshot(fps: number, remoteXs: number[]): E2EWorldSnapshot {
  return {
    tick: 10,
    mapId: 0,
    local: player(0),
    remotePlayers: remoteXs.map(player),
    zones: [],
    huddles: [],
    fps,
  };
}

describe('perSecond', () => {
  it('divides the delta by the elapsed seconds', () => {
    expect(perSecond(30, 0.25)).toBe(120);
  });

  it('reads zero until time has passed', () => {
    expect(perSecond(5, 0)).toBe(0);
    expect(perSecond(5, -1)).toBe(0);
  });
});

describe('perfHudLine', () => {
  it('prints the fps, the remote count, the update rate and how far apart the remotes stand', () => {
    expect(perfHudLine(snapshot(59.6, [340.4, 100, 220]), 12.4)).toBe(
      ['FPS        60', 'remotes    3', 'row upd/s  12', 'x-spread   240px'].join('\n'),
    );
  });

  it('reads a zero spread when no remote is drawn', () => {
    expect(perfHudLine(snapshot(0, []), 0)).toBe(
      ['FPS        0', 'remotes    0', 'row upd/s  0', 'x-spread   0px'].join('\n'),
    );
  });
});
