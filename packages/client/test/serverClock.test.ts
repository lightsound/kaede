import { describe, expect, it } from 'vitest';
import { createServerClock } from '../src/net.package/serverClock';

describe('createServerClock', () => {
  it('has no estimate before any sample', () => {
    const clock = createServerClock();
    expect(clock.serverNow(1000)).toBeUndefined();
  });

  it('maps local time onto the server timeline using the observed offset', () => {
    const clock = createServerClock();
    // Server stamped 5000, we received it at local 5040: offset 40ms.
    clock.record(5000, 5040);
    expect(clock.serverNow(5040)).toBe(5000);
    expect(clock.serverNow(5140)).toBe(5100);
  });

  it('keeps the minimum offset, so delivery jitter never shifts the timeline', () => {
    const clock = createServerClock();
    clock.record(1000, 1040); // fast delivery: offset 40
    clock.record(1100, 1250); // delayed packet: offset 150 (ignored)
    clock.record(1200, 1260); // offset 60 (ignored)
    expect(clock.serverNow(2040)).toBe(2000);
  });

  it('adapts after the window rotates twice', () => {
    const clock = createServerClock();
    clock.record(0, 40); // offset 40 in the first bucket
    // Two rotations later the old minimum is gone; only the new offset remains.
    clock.record(21_000, 21_100); // rotates, offset 100
    clock.record(43_000, 43_100); // rotates again, offset 100
    expect(clock.serverNow(50_100)).toBe(50_000);
  });
});
