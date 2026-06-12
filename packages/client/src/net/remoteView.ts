import { INTERP_DELAY_MS, toFacing, type Facing } from '@maple/shared';
import {
  correctionOffset,
  decayOffset,
  hermite,
  REMOTE_DISCONTINUITY_SPEED,
  type Vec2,
} from '../game/smoothing';

/** One timestamped position sample for a remote player. */
interface Snapshot {
  t: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  facing: Facing;
}

/**
 * Per-remote render state: the display name, the snapshot buffer, plus the
 * smoothing carry (the decaying error offset and the previous rendered position
 * used to detect target discontinuities).
 */
interface RemoteView {
  name: string;
  snaps: Snapshot[];
  offset: Vec2;
  prevRendered?: Vec2;
  lastFrameMs?: number;
}

/** Discard samples older than this, but always keep the last two to interpolate. */
const SNAPSHOT_TTL_MS = 1500;

/**
 * Buffers authoritative remote-player rows as timestamped snapshots and renders
 * them interpolated INTERP_DELAY_MS in the past, smoothing over any snapshot
 * discontinuities (teleports, reorders) with a decaying error offset so the
 * rendered path stays continuous.
 */
export function createRemoteViews() {
  const views = new Map<string, RemoteView>();

  // Inbound (remote): buffer a timestamped snapshot for each remote row change.
  function record(
    idHex: string,
    name: string,
    row: { x: number; y: number; vx: number; vy: number; facing: number },
    nowMs: number,
  ): void {
    let view = views.get(idHex);
    if (!view) {
      view = { name, snaps: [], offset: { x: 0, y: 0 } };
      views.set(idHex, view);
    }
    view.name = name;
    view.snaps.push({
      t: nowMs,
      x: row.x,
      y: row.y,
      vx: row.vx,
      vy: row.vy,
      facing: toFacing(row.facing),
    });
  }

  function remove(idHex: string): void {
    views.delete(idHex);
  }

  // Render remote players interpolated INTERP_DELAY_MS in the past, smoothing
  // over any snapshot discontinuities (teleports, reorders) with a decaying
  // error offset so the rendered path stays continuous.
  function renderFrame(
    nowMs: number,
    draw: (idHex: string, name: string, x: number, y: number, facing: Facing) => void,
  ): void {
    const renderTime = nowMs - INTERP_DELAY_MS;
    for (const [idHex, view] of views) {
      prune(view.snaps, nowMs);
      if (view.snaps.length === 0) continue;
      const target = sampleAt(view.snaps, renderTime);

      const frameDt = view.lastFrameMs !== undefined ? nowMs - view.lastFrameMs : 0;
      // Discontinuity: target jumped further than authoritative motion allows.
      // Reanchor the offset on the previous rendered position (which already
      // folds in the old offset), keeping the rendered path continuous.
      if (
        view.prevRendered &&
        dist(target, view.prevRendered) > REMOTE_DISCONTINUITY_SPEED * (frameDt / 1000) + 1
      ) {
        view.offset = correctionOffset(view.prevRendered, target);
      }
      view.offset = decayOffset(view.offset, frameDt);

      const rx = target.x + view.offset.x;
      const ry = target.y + view.offset.y;
      view.prevRendered = { x: rx, y: ry };
      view.lastFrameMs = nowMs;
      draw(idHex, view.name, rx, ry, target.facing);
    }
  }

  return { record, remove, renderFrame };
}

/** Euclidean distance between two points. */
function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Drop samples older than the TTL, always keeping at least the last two. */
function prune(buf: Snapshot[], now: number): void {
  while (buf.length > 2 && now - buf[0].t > SNAPSHOT_TTL_MS) buf.shift();
}

/**
 * Returns the position at renderTime by cubic-Hermite interpolating between the
 * two straddling snapshots (using their authoritative velocities as tangents).
 * Clamps to the nearest snapshot outside the buffered range (no extrapolation).
 * facing comes from the later snapshot.
 */
function sampleAt(buf: Snapshot[], renderTime: number): Snapshot {
  if (renderTime <= buf[0].t) return buf[0];
  const last = buf[buf.length - 1];
  if (renderTime >= last.t) return last;
  for (let i = 1; i < buf.length; i++) {
    const b = buf[i];
    if (renderTime <= b.t) {
      const a = buf[i - 1];
      const span = b.t - a.t;
      if (span <= 0) return { ...b, t: renderTime };
      const p = hermite(a, b, renderTime);
      return { t: renderTime, x: p.x, y: p.y, vx: b.vx, vy: b.vy, facing: b.facing };
    }
  }
  return last;
}
