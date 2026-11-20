import { describe, expect, it } from 'vite-plus/test';
import { createServerClock } from '../src/net.package/serverClock';

describe('createServerClock', () => {
  it('has no estimate before any sample', () => {
    const clock = createServerClock();
    expect(clock.serverNow(1000)).toBeUndefined();
  });

  it('maps local time onto the server timeline using the observed offset', () => {
    const clock = createServerClock();
    clock.record(5000, 5040);
    expect(clock.serverNow(5040)).toBe(5000);
    expect(clock.serverNow(5140)).toBe(5100);
  });

  it('keeps the minimum offset, so delivery jitter never shifts the timeline', () => {
    const clock = createServerClock();
    clock.record(1000, 1040);
    clock.record(1100, 1250);
    clock.record(1200, 1260);
    expect(clock.serverNow(2040)).toBe(2000);
  });

  it('adapts after the window rotates twice', () => {
    const clock = createServerClock();
    clock.record(0, 40);
    clock.record(21_000, 21_100);
    clock.record(43_000, 43_100);
    expect(clock.serverNow(50_100)).toBe(50_000);
  });
});
