/**
 * Pure render-smoothing math. No Pixi, no DOM, no side effects, so it stays
 * unit-testable under plain Node; keep it dependency-free.
 */

export interface Vec2 {
  x: number;
  y: number;
}

/** Error offsets decay as exp(-dt/tau); tau in ms. */
const SMOOTH_TAU_MS = 80;
/** Corrections larger than this (px) snap instantly instead of smearing. */
const SMOOTH_MAX_OFFSET_PX = 160;
/** Offsets below this magnitude (px) are zeroed to avoid endless drift. */
const SMOOTH_EPSILON_PX = 0.5;
/** Frame-to-frame remote target motion above this (px/s) is a discontinuity. */
export const REMOTE_DISCONTINUITY_SPEED = 2000;
/** Hermite segments longer than this (ms) fall back to linear interpolation. */
const HERMITE_MAX_SEGMENT_MS = 250;

/**
 * The render-error offset to carry after a correction: how far the previously
 * rendered position sat ahead of the corrected one. Big teleports must snap
 * (offset 0), not smear, so corrections beyond SMOOTH_MAX_OFFSET_PX are dropped.
 */
export function correctionOffset(prevRendered: Vec2, corrected: Vec2): Vec2 {
  const x = prevRendered.x - corrected.x;
  const y = prevRendered.y - corrected.y;
  if (Math.hypot(x, y) > SMOOTH_MAX_OFFSET_PX) return { x: 0, y: 0 };
  return { x, y };
}

/** Exponentially decay an offset toward zero; snaps to zero below epsilon. */
export function decayOffset(off: Vec2, dtMs: number): Vec2 {
  const k = Math.exp(-dtMs / SMOOTH_TAU_MS);
  const x = off.x * k;
  const y = off.y * k;
  if (Math.hypot(x, y) < SMOOTH_EPSILON_PX) return { x: 0, y: 0 };
  return { x, y };
}

/** An interpolation endpoint: a timestamped position with its velocity. */
export interface HermitePoint {
  t: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/**
 * Cubic Hermite interpolation on the segment [a, b], using each endpoint's
 * velocity for the tangents. Callers guarantee a.t <= renderTime <= b.t and
 * a.t < b.t. Segments longer than HERMITE_MAX_SEGMENT_MS fall back to linear
 * interpolation, since velocity * a long gap swings the curve wildly.
 */
export function hermite(a: HermitePoint, b: HermitePoint, renderTime: number): Vec2 {
  const span = b.t - a.t;
  const s = (renderTime - a.t) / span;
  if (span > HERMITE_MAX_SEGMENT_MS) {
    return { x: a.x + (b.x - a.x) * s, y: a.y + (b.y - a.y) * s };
  }
  const dtS = span / 1000;
  const s2 = s * s;
  const s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1;
  const h10 = (s3 - 2 * s2 + s) * dtS;
  const h01 = -2 * s3 + 3 * s2;
  const h11 = (s3 - s2) * dtS;
  return {
    x: h00 * a.x + h10 * a.vx + h01 * b.x + h11 * b.vx,
    y: h00 * a.y + h10 * a.vy + h01 * b.y + h11 * b.vy,
  };
}
