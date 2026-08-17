import { type Facing, GRAVITY, INTERP_DELAY_MS, MAX_FALL_SPEED, toFacing } from '@kaede/shared';
import type { PlayerLabel } from '../game.package';
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
  /**
   * True when the sampled state is in free fall (neither grounded nor on a
   * rope), so extrapolation past this sample must integrate gravity: carrying
   * a stale upward velocity in a straight line makes the player float.
   */
  airborne: boolean;
}

/**
 * Per-remote render state: the display attributes (name and composed
 * status line), the snapshot buffer, plus the smoothing carry (the
 * decaying error offset and the previous rendered position used to detect
 * target discontinuities).
 */
interface RemoteView {
  label: PlayerLabel;
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

  // Inbound (remote): buffer a snapshot for each remote row change with the
  // display attributes the caller read from its cache, and feed the clock
  // estimator with the (server time, receive time) pair.
  function record(
    idHex: string,
    label: PlayerLabel,
    row: {
      x: number;
      y: number;
      vx: number;
      vy: number;
      facing: number;
      onGround: boolean;
      rope: number;
      updatedAtMs: number;
    },
    nowMs: number,
  ): void {
    clock.record(row.updatedAtMs, nowMs);
    let view = views.get(idHex);
    if (!view) {
      view = { label, snaps: [], offset: { x: 0, y: 0 } };
      views.set(idHex, view);
    }
    view.label = label;
    view.snaps.push({
      t: row.updatedAtMs,
      x: row.x,
      y: row.y,
      vx: row.vx,
      vy: row.vy,
      facing: toFacing(row.facing),
      airborne: !row.onGround && row.rope < 0,
    });
  }

  /**
   * Renames an existing view (the player_name row changed without the hot
   * row moving). A view that does not exist yet is skipped, not created: the
   * next record() call supplies the current name anyway, and a snapshot-less
   * view would only make renderFrame skip it.
   */
  function setName(idHex: string, name: string): void {
    const view = views.get(idHex);
    if (view) view.label = { ...view.label, name };
  }

  /**
   * Updates an existing view's status line (a player_status row changed
   * without the hot row moving). Skipped like setName while the view does
   * not exist: the next record() call supplies the current status anyway.
   */
  function setStatus(
    idHex: string,
    status: string | undefined,
    availability: string | undefined,
  ): void {
    const view = views.get(idHex);
    if (view) view.label = { ...view.label, status, availability };
  }

  /**
   * Updates an existing view's state-gesture directive (a gesture row
   * changed without the hot row moving — the normal case: gestures are
   * struck standing still, and the server clears the row on movement).
   * Skipped like setName while the view does not exist: the next record()
   * call supplies the cached gesture anyway.
   */
  function setGesture(idHex: string, gesture: string | undefined): void {
    const view = views.get(idHex);
    if (view) view.label = { ...view.label, gesture };
  }

  /**
   * Updates an existing view's zone occupancy tag (a group_member row
   * changed without the hot row moving — e.g. an admin edited the zone
   * under a standing player). Skipped like setName while the view does not
   * exist: the next record() call supplies the current tag anyway.
   */
  function setZone(idHex: string, zone: string | undefined): void {
    const view = views.get(idHex);
    if (view) view.label = { ...view.label, zone };
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
    draw: (idHex: string, label: PlayerLabel, x: number, y: number, facing: Facing) => void,
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
      draw(idHex, view.label, rx, ry, target.facing);
    }
  }

  return { record, setName, setStatus, setGesture, setZone, remove, clear, renderFrame };
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
 * cubic-Hermite interpolates using the authoritative velocities as tangents
 * (a cubic through two position+velocity endpoints of a gravity arc IS that
 * parabola, so jump segments reconstruct exactly). Past the newest snapshot,
 * extrapolates along its velocity — integrating gravity when the sample is
 * airborne, so a stale upward velocity arcs over instead of floating — for at
 * most REMOTE_EXTRAPOLATION_MAX_MS, then freezes. Before the oldest, clamps.
 * facing comes from the nearest later (or last) snapshot.
 */
export function sampleAt(buf: Snapshot[], renderTime: number): Snapshot {
  if (renderTime <= buf[0].t) return buf[0];
  const last = buf[buf.length - 1];
  if (renderTime >= last.t) {
    const dtS = Math.min(renderTime - last.t, REMOTE_EXTRAPOLATION_MAX_MS) / 1000;
    const y = last.airborne ? ballisticY(last.y, last.vy, dtS) : last.y + last.vy * dtS;
    return { ...last, t: renderTime, x: last.x + last.vx * dtS, y };
  }
  for (let i = 1; i < buf.length; i++) {
    const b = buf[i];
    if (renderTime <= b.t) {
      const a = buf[i - 1];
      const span = b.t - a.t;
      if (span <= 0) return { ...b, t: renderTime };
      const p = hermite(a, b, renderTime);
      return { ...b, t: renderTime, x: p.x, y: clampAtFloor(a, b, p.y) };
    }
  }
  return last;
}

/**
 * Keeps an interpolated y on the walkable side of a segment's floor. A
 * landing segment pairs an airborne endpoint's steep falling tangent with a
 * grounded endpoint's zero tangent, so the cubic can swing well below the
 * floor before returning to it — but the true path stops AT b's floor: a
 * rebound is impossible, and re-jumping back onto it takes longer than a
 * flush window. Symmetrically, a walk-off-a-ledge segment (grounded a,
 * airborne b below) only ever descends from a's floor, so the curve must
 * not hover above it. Rising landings (a below b's floor) legitimately arc
 * over it and pass through untouched. y grows downward (screen coords).
 */
function clampAtFloor(a: Snapshot, b: Snapshot, y: number): number {
  if (a.airborne && !b.airborne && a.y <= b.y) return Math.min(y, b.y);
  if (!a.airborne && b.airborne && b.y >= a.y) return Math.max(y, a.y);
  return y;
}

/**
 * Vertical free-fall position after dtS seconds: integrates the shared
 * GRAVITY from the sampled vy, switching to constant MAX_FALL_SPEED once
 * reached (the same clamp stepPlayer applies, which also guarantees
 * vy <= MAX_FALL_SPEED here). No collision — a landing inside the window
 * overshoots the floor by at most half a flush of fall, and the offset
 * smoothing eases it back like any other correction.
 */
function ballisticY(y: number, vy: number, dtS: number): number {
  const accelS = Math.min(dtS, (MAX_FALL_SPEED - vy) / GRAVITY);
  const terminalS = dtS - accelS;
  return y + vy * accelS + (GRAVITY * accelS * accelS) / 2 + MAX_FALL_SPEED * terminalS;
}
