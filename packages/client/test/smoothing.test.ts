import { GRAVITY, INPUT_FLUSH_INTERVAL_MS } from '@kaede/shared';
import { describe, expect, it } from 'vitest';
import {
  correctionOffset,
  decayOffset,
  HERMITE_MAX_SEGMENT_MS,
  hermite,
} from '../src/smoothing.package/smoothing';

describe('correctionOffset', () => {
  it('carries the render error after a small correction', () => {
    expect(correctionOffset({ x: 110, y: 50 }, { x: 100, y: 40 })).toEqual({ x: 10, y: 10 });
  });

  it('drops to zero for teleport-sized corrections (snap, not smear)', () => {
    expect(correctionOffset({ x: 1000, y: 0 }, { x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
  });
});

describe('decayOffset', () => {
  it('decays exponentially toward zero', () => {
    const start = { x: 100, y: 0 };
    const once = decayOffset(start, 80); // one time constant: ~36.8% remains
    expect(once.x).toBeCloseTo(100 * Math.exp(-1), 5);
    expect(decayOffset(once, 80).x).toBeLessThan(once.x);
  });

  it('snaps to exactly zero below the epsilon so drift terminates', () => {
    expect(decayOffset({ x: 0.4, y: 0.2 }, 16)).toEqual({ x: 0, y: 0 });
  });
});

describe('hermite', () => {
  const a = { t: 0, x: 0, y: 0, vx: 100, vy: 0 };
  const b = { t: 100, x: 10, y: 5, vx: 100, vy: 0 };

  it('hits both endpoints exactly', () => {
    expect(hermite(a, b, 0)).toEqual({ x: 0, y: 0 });
    const end = hermite(a, b, 100);
    expect(end.x).toBeCloseTo(10, 10);
    expect(end.y).toBeCloseTo(5, 10);
  });

  it('reduces to linear interpolation when velocities match the segment slope', () => {
    // 100px/s over a 100ms segment is exactly the chord slope: the curve is a line.
    expect(hermite(a, b, 50).x).toBeCloseTo(5, 10);
  });

  it('falls back to linear interpolation on segments longer than the cap', () => {
    const far = { t: 1000, x: 10, y: 0, vx: -10_000, vy: 0 };
    // With hermite tangents this would swing wildly; linear gives the midpoint.
    expect(hermite(a, far, 500)).toEqual({ x: 5, y: 0 });
  });

  it('covers a full input-flush segment, so per-batch snapshots interpolate curved', () => {
    // Remote snapshots arrive one per flush; a cap below the flush interval
    // would make hermite dead code and render jump arcs as straight lines.
    expect(HERMITE_MAX_SEGMENT_MS).toBeGreaterThan(INPUT_FLUSH_INTERVAL_MS);
  });

  it('reconstructs a gravity arc exactly from one flush-length segment', () => {
    // A jump sampled only at flush boundaries: both endpoints carry the
    // authoritative position and velocity of the same parabola, and the cubic
    // through them IS that parabola — so the remote arc renders curved even
    // at one snapshot per flush.
    const dtS = INPUT_FLUSH_INTERVAL_MS / 1000;
    const vy0 = -840;
    const arcY = (t: number) => vy0 * t + (GRAVITY * t * t) / 2;
    const start = { t: 0, x: 0, y: 0, vx: 240, vy: vy0 };
    const end = {
      t: INPUT_FLUSH_INTERVAL_MS,
      x: 240 * dtS,
      y: arcY(dtS),
      vx: 240,
      vy: vy0 + GRAVITY * dtS,
    };
    const mid = hermite(start, end, INPUT_FLUSH_INTERVAL_MS / 2);
    expect(mid.x).toBeCloseTo(240 * (dtS / 2), 8);
    expect(mid.y).toBeCloseTo(arcY(dtS / 2), 8);
  });
});
