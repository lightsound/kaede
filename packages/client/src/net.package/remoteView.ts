import { type Facing, INTERP_DELAY_MS, toFacing } from '@maple/shared';
import {
  correctionOffset,
  decayOffset,
  type HermitePoint,
  hermite,
  REMOTE_DISCONTINUITY_SPEED,
  type Vec2,
} from '../smoothing.package';
import { createServerClock } from './serverClock';

/** One position sample for a remote player, timestamped on the SERVER clock. */
export interface Snapshot extends HermitePoint {
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
 * When the snapshot buffer runs dry (a delivery gap), keep moving the player
 * along its last authoritative velocity for at most this long before freezing.
 * The discontinuity smoothing eases any overshoot back when real data returns.
 */
export const REMOTE_EXTRAPOLATION_MAX_MS = 250;

/**
 * Buffers authoritative remote-player rows as snapshots on the server timeline
 * (row.updatedAt), and renders them interpolated INTERP_DELAY_MS in the past.
 * Anchoring on server timestamps means delivery jitter cannot distort the
 * spacing between samples; a clock-offset estimator maps the local render
 * clock onto the server timeline. Snapshot discontinuities (teleports,
 * estimator shifts) are smoothed with a decaying error offset so the rendered
 * path stays continuous.
 */
export function createRemoteViews() {
  const views = new Map<string, RemoteView>();
  const clock = createServerClock();

  // Inbound (remote): buffer a snapshot for each remote row change, and feed
  // the clock estimator with the (server time, receive time) pair.
  function record(
    idHex: string,
    name: string,
    row: { x: number; y: number; vx: number; vy: number; facing: number; updatedAtMs: number },
    nowMs: number,
  ): void {
    clock.record(row.updatedAtMs, nowMs);
    let view = views.get(idHex);
    if (!view) {
      view = { name, snaps: [], offset: { x: 0, y: 0 } };
      views.set(idHex, view);
    }
    view.name = name;
    view.snaps.push({
      t: row.updatedAtMs,
      x: row.x,
      y: row.y,
      vx: row.vx,
      vy: row.vy,
      facing: toFacing(row.facing),
    });
  }

  /**
   * Renames an existing view (the player_name row changed without the hot
   * row moving). A view that does not exist yet is skipped, not created: the
   * next record() reads the current name from the row cache anyway, and a
   * snapshot-less view would only make renderFrame skip it.
   */
  function setName(idHex: string, name: string): void {
    const view = views.get(idHex);
    if (view) view.name = name;
  }

  function remove(idHex: string): void {
    views.delete(idHex);
  }

  /** Drop all remote state (e.g. when the connection is lost). */
  function clear(): void {
    views.clear();
  }

  // Render remote players interpolated INTERP_DELAY_MS in the past, smoothing
  // over any snapshot discontinuities (teleports, reorders) with a decaying
  // error offset so the rendered path stays continuous.
  function renderFrame(
    nowMs: number,
    draw: (idHex: string, name: string, x: number, y: number, facing: Facing) => void,
  ): void {
    const serverNowMs = clock.serverNow(nowMs);
    if (serverNowMs === undefined) return; // no samples yet: nothing to render anyway
    const renderTime = serverNowMs - INTERP_DELAY_MS;
    for (const [idHex, view] of views) {
      prune(view.snaps, serverNowMs);
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

  return { record, setName, remove, clear, renderFrame };
}

/** Euclidean distance between two points. */
function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Drop samples older than the TTL, always keeping at least the last two. */
function prune(buf: Snapshot[], serverNowMs: number): void {
  while (buf.length > 2 && serverNowMs - buf[0].t > SNAPSHOT_TTL_MS) buf.shift();
}

/**
 * Returns the position at renderTime (server timeline). Between snapshots,
 * cubic-Hermite interpolates using the authoritative velocities as tangents.
 * Past the newest snapshot, extrapolates along its velocity for at most
 * REMOTE_EXTRAPOLATION_MAX_MS, then freezes. Before the oldest, clamps.
 * facing comes from the nearest later (or last) snapshot.
 */
export function sampleAt(buf: Snapshot[], renderTime: number): Snapshot {
  if (renderTime <= buf[0].t) return buf[0];
  const last = buf[buf.length - 1];
  if (renderTime >= last.t) {
    const dtS = Math.min(renderTime - last.t, REMOTE_EXTRAPOLATION_MAX_MS) / 1000;
    return { ...last, t: renderTime, x: last.x + last.vx * dtS, y: last.y + last.vy * dtS };
  }
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
