import { type Facing, INTERP_DELAY_MS } from '@maple/shared';
import { describe, expect, it } from 'vitest';
import {
  createRemoteViews,
  REMOTE_EXTRAPOLATION_MAX_MS,
  sampleAt,
} from '../src/net.package/remoteView';

const facing: Facing = 1;

/** A snapshot on the server timeline with sensible defaults. */
function snap(t: number, x: number, over: Partial<{ y: number; vx: number; vy: number }> = {}) {
  return { t, x, y: over.y ?? 0, vx: over.vx ?? 0, vy: over.vy ?? 0, facing };
}

describe('sampleAt', () => {
  it('clamps before the oldest snapshot', () => {
    const buf = [snap(1000, 10), snap(1100, 20)];
    expect(sampleAt(buf, 900).x).toBe(10);
  });

  it('interpolates between straddling snapshots (exact at endpoints)', () => {
    const buf = [snap(1000, 10, { vx: 100 }), snap(1100, 20, { vx: 100 })];
    expect(sampleAt(buf, 1000).x).toBe(10);
    expect(sampleAt(buf, 1100).x).toBeCloseTo(20, 10);
    const mid = sampleAt(buf, 1050);
    expect(mid.x).toBeGreaterThan(10);
    expect(mid.x).toBeLessThan(20);
  });

  it('extrapolates past the newest snapshot along its velocity', () => {
    const buf = [snap(1000, 10), snap(1100, 20, { vx: 100 })];
    // 50ms past the last snapshot at 100px/s: 5px further.
    expect(sampleAt(buf, 1150).x).toBeCloseTo(25, 10);
  });

  it('caps extrapolation at REMOTE_EXTRAPOLATION_MAX_MS, then freezes', () => {
    const buf = [snap(1100, 20, { vx: 100 })];
    const capped = 20 + (100 * REMOTE_EXTRAPOLATION_MAX_MS) / 1000;
    expect(sampleAt(buf, 1100 + REMOTE_EXTRAPOLATION_MAX_MS).x).toBeCloseTo(capped, 10);
    expect(sampleAt(buf, 1100 + REMOTE_EXTRAPOLATION_MAX_MS + 5000).x).toBeCloseTo(capped, 10);
  });

  it('does not move a standing player when snapshots run dry', () => {
    const buf = [snap(1100, 20)];
    expect(sampleAt(buf, 9999).x).toBe(20);
  });
});

describe('createRemoteViews', () => {
  /** Row shape record() expects, built from a server-time position sample. */
  function row(updatedAtMs: number, x: number, vx = 0) {
    return { x, y: 0, vx, vy: 0, facing: 1, updatedAtMs };
  }

  /** Collect draw() calls for one renderFrame. */
  function render(views: ReturnType<typeof createRemoteViews>, nowMs: number) {
    const drawn: { id: string; x: number; y: number }[] = [];
    views.renderFrame(nowMs, (id, _name, x, y) => drawn.push({ id, x, y }));
    return drawn;
  }

  it('renders INTERP_DELAY_MS in the past on the server timeline', () => {
    const views = createRemoteViews();
    // Constant 40ms delivery delay; player moves 10px per 100ms server tick.
    for (let i = 0; i <= 5; i++) {
      views.record('a', 'A', row(i * 100, i * 10, 100), i * 100 + 40);
    }
    // Local 540 maps to server 500; render time is 500 - INTERP_DELAY_MS.
    const drawn = render(views, 540);
    expect(drawn).toHaveLength(1);
    expect(drawn[0].x).toBeCloseTo((500 - INTERP_DELAY_MS) / 10, 5);
  });

  it('is immune to delivery jitter of individual updates', () => {
    const jittered = createRemoteViews();
    const steady = createRemoteViews();
    for (let i = 0; i <= 5; i++) {
      // Same server-time samples; one connection delivers with jitter.
      const jitter = i % 2 === 0 ? 0 : 35;
      jittered.record('a', 'A', row(i * 100, i * 10, 100), i * 100 + 40 + jitter);
      steady.record('a', 'A', row(i * 100, i * 10, 100), i * 100 + 40);
    }
    // Both estimated the same (minimum) offset, so they render identically.
    expect(render(jittered, 540)[0].x).toBeCloseTo(render(steady, 540)[0].x, 5);
  });

  it('remove() and clear() drop views', () => {
    const views = createRemoteViews();
    views.record('a', 'A', row(0, 0), 40);
    views.record('b', 'B', row(0, 0), 40);
    views.remove('a');
    expect(render(views, 240).map((d) => d.id)).toEqual(['b']);
    views.clear();
    expect(render(views, 250)).toHaveLength(0);
  });
});
