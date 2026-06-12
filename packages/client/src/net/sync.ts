import {
  DEFAULT_MAP,
  INPUT_BATCH_MAX_TICKS,
  INTERP_DELAY_MS,
  PREDICTION_HISTORY_MAX_TICKS,
  RESEND_TIMEOUT_MS,
  SNAPSHOT_SEND_INTERVAL_MS,
  stepPlayer,
  unpackInput,
  type Facing,
  type PlayerState,
} from '@maple/shared';
import type { GameApp } from '../game/GameApp';
import type { DbConnection } from '../module_bindings';
import {
  correctionOffset,
  decayOffset,
  hermite,
  REMOTE_DISCONTINUITY_SPEED,
  type Vec2,
} from '../game/smoothing';
import { connect } from './connection';

/** The generated own/remote player row type (all columns). */
type PlayerRow =
  ReturnType<DbConnection['db']['player']['iter']> extends Iterator<infer R> ? R : never;

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
 * Per-remote render state: the snapshot buffer plus the smoothing carry (the
 * decaying error offset and the previous rendered position used to detect
 * target discontinuities).
 */
interface RemoteView {
  snaps: Snapshot[];
  offset: Vec2;
  prevRendered?: Vec2;
  lastFrameMs?: number;
}

/** Discard samples older than this, but always keep the last two to interpolate. */
const SNAPSHOT_TTL_MS = 1500;

const toFacing = (f: number): Facing => (f < 0 ? -1 : 1);

const rowToState = (row: PlayerRow): PlayerState => ({
  x: row.x,
  y: row.y,
  vx: row.vx,
  vy: row.vy,
  facing: row.facing < 0 ? -1 : 1,
  onGround: row.onGround,
});

const sameState = (a: PlayerState, b: PlayerState): boolean =>
  a.x === b.x &&
  a.y === b.y &&
  a.vx === b.vx &&
  a.vy === b.vy &&
  a.facing === b.facing &&
  a.onGround === b.onGround;

export interface Net {
  dispose(): void;
}

/**
 * Wires the game to SpacetimeDB. The server is authoritative: the client sends
 * only inputs (batched through submit_inputs) and predicts locally, replaying
 * un-acked inputs whenever the authoritative row disagrees with our prediction.
 * Remote players are rendered interpolated INTERP_DELAY_MS in the past.
 */
export function startNet(gameApp: GameApp): Net {
  const views = new Map<string, RemoteView>();
  const names = new Map<string, string>();
  let conn: DbConnection | undefined;
  let myIdHex = '';
  let disposed = false;

  // Prediction bookkeeping. history[t] is the packed input applied to produce
  // predicted[t]; both are pruned once tick t is acknowledged by the server.
  const history = new Map<number, number>();
  const predicted = new Map<number, PlayerState>();
  let currentTick = 0;
  let ackedTick = 0;
  let lastSentTick = 0;
  let lastAckAdvanceAt = 0;
  let lastFlushMs = 0;

  // Outbound: collect each predicted tick, and flush pending inputs on the
  // SNAPSHOT_SEND_INTERVAL_MS cadence (driven by the local tick timing, like
  // the old throttle).
  gameApp.onLocalTick((state, tick, packedInput) => {
    if (!conn) return;
    currentTick = tick;
    history.set(tick, packedInput);
    predicted.set(tick, state);

    // Bound history memory: drop the oldest entries beyond the cap.
    while (history.size > PREDICTION_HISTORY_MAX_TICKS) {
      const oldest = tick - history.size + 1;
      history.delete(oldest);
      predicted.delete(oldest);
    }

    const now = performance.now();
    if (now - lastFlushMs < SNAPSHOT_SEND_INTERVAL_MS) return;
    lastFlushMs = now;
    flush(now);
  });

  function flush(now: number): void {
    if (!conn) return;

    // Watchdog: if our latest send is still un-acked and has gone quiet, rewind
    // lastSentTick to force a full resend. The server's startTick === row.tick
    // check makes any duplicates harmless.
    if (lastSentTick > ackedTick && now - lastAckAdvanceAt > RESEND_TIMEOUT_MS) {
      lastSentTick = ackedTick;
      lastAckAdvanceAt = now;
    }

    // Send ticks (lastSentTick, currentTick] in chunks of <= INPUT_BATCH_MAX_TICKS.
    let base = lastSentTick;
    while (base < currentTick) {
      const end = Math.min(base + INPUT_BATCH_MAX_TICKS, currentTick);
      const packed: number[] = [];
      for (let t = base + 1; t <= end; t++) packed.push(history.get(t) ?? 0);
      // chunkBase is the tick BEFORE the chunk's first input: the server accepts
      // the batch iff startTick === its current applied-tick count.
      conn.reducers
        .submitInputs({ startTick: base, inputs: new Uint8Array(packed) })
        .catch(() => {});
      base = end;
    }
    lastSentTick = currentTick;
  }

  /** Ack path: an own-row update IS the acknowledgement (row.tick = applied). */
  function onAck(row: PlayerRow): void {
    const ack = row.tick;
    if (ack > ackedTick) lastAckAdvanceAt = performance.now();

    const mine = predicted.get(ack);
    if (mine && sameState(mine, rowToState(row))) {
      // Prediction matched: just advance the ack horizon.
      ackedTick = ack;
      prunePredictionsUpTo(ack);
      return;
    }

    // Reconcile: the server diverged (or we lost the predicted state). Replay
    // un-acked inputs from the authoritative state forward to currentTick.
    if (ack < currentTick && !history.has(ack + 1)) {
      // The ack predates everything we still keep: we can't replay the missing
      // inputs. Hard reset to the authoritative row and start over from there.
      history.clear();
      predicted.clear();
      currentTick = ack;
      ackedTick = ack;
      lastSentTick = ack;
      gameApp.resetLocal(rowToState(row), ack);
      return;
    }

    let s = rowToState(row);
    for (let t = ack + 1; t <= currentTick; t++) {
      s = stepPlayer(s, unpackInput(history.get(t) ?? 0), DEFAULT_MAP);
      predicted.set(t, s);
    }
    gameApp.resetLocal(s, currentTick);
    ackedTick = ack;
    prunePredictionsUpTo(ack);
  }

  function prunePredictionsUpTo(tick: number): void {
    for (const t of history.keys()) if (t <= tick) history.delete(t);
    for (const t of predicted.keys()) if (t <= tick) predicted.delete(t);
  }

  // Inbound (remote): buffer a timestamped snapshot for each remote row change.
  const record = (idHex: string, row: PlayerRow) => {
    let view = views.get(idHex);
    if (!view) {
      view = { snaps: [], offset: { x: 0, y: 0 } };
      views.set(idHex, view);
    }
    view.snaps.push({
      t: performance.now(),
      x: row.x,
      y: row.y,
      vx: row.vx,
      vy: row.vy,
      facing: toFacing(row.facing),
    });
  };

  const handleRemote = (idHex: string, row: PlayerRow) => {
    names.set(idHex, row.name);
    record(idHex, row);
  };

  connect()
    .then(({ conn: c, myIdHex: id }) => {
      if (disposed) {
        c.disconnect();
        return;
      }
      conn = c;
      myIdHex = id;

      // Find our own row and start the simulation from the authoritative spawn
      // state. Other rows already in the cache are seeded as remote players.
      let ownRow: PlayerRow | undefined;
      for (const row of c.db.player.iter()) {
        const idHex = row.identity.toHexString();
        if (idHex === myIdHex) {
          ownRow = row;
          continue;
        }
        handleRemote(idHex, row);
      }
      if (ownRow) {
        gameApp.setLocalPlayerName(ownRow.name);
        currentTick = ownRow.tick;
        ackedTick = ownRow.tick;
        lastSentTick = ownRow.tick;
        lastAckAdvanceAt = performance.now();
        gameApp.start(rowToState(ownRow), ownRow.tick);
      }

      c.db.player.onInsert((_ctx, row) => {
        const idHex = row.identity.toHexString();
        if (idHex === myIdHex) return;
        handleRemote(idHex, row);
      });
      c.db.player.onUpdate((_ctx, _old, row) => {
        const idHex = row.identity.toHexString();
        if (idHex === myIdHex) {
          onAck(row);
          return;
        }
        handleRemote(idHex, row);
      });
      c.db.player.onDelete((_ctx, row) => {
        const idHex = row.identity.toHexString();
        if (idHex === myIdHex) return;
        views.delete(idHex);
        names.delete(idHex);
        gameApp.removeRemotePlayer(idHex);
      });
    })
    .catch(() => {});

  // Render remote players interpolated INTERP_DELAY_MS in the past, smoothing
  // over any snapshot discontinuities (teleports, reorders) with a decaying
  // error offset so the rendered path stays continuous.
  gameApp.onFrame((now) => {
    const renderTime = now - INTERP_DELAY_MS;
    for (const [idHex, view] of views) {
      prune(view.snaps, now);
      if (view.snaps.length === 0) continue;
      const target = sampleAt(view.snaps, renderTime);

      const frameDt = view.lastFrameMs !== undefined ? now - view.lastFrameMs : 0;
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
      view.lastFrameMs = now;
      gameApp.upsertRemotePlayer(idHex, names.get(idHex) ?? '', rx, ry, target.facing);
    }
  });

  return {
    dispose() {
      disposed = true;
      conn?.disconnect();
      conn = undefined;
    },
  };
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
