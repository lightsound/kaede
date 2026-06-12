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
import { connect } from './connection';

/** The generated own/remote player row type (all columns). */
type PlayerRow =
  ReturnType<DbConnection['db']['player']['iter']> extends Iterator<infer R> ? R : never;

/** One timestamped position sample for a remote player. */
interface Snapshot {
  t: number;
  x: number;
  y: number;
  facing: Facing;
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
  const buffers = new Map<string, Snapshot[]>();
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
  const record = (idHex: string, x: number, y: number, facing: number) => {
    let buf = buffers.get(idHex);
    if (!buf) {
      buf = [];
      buffers.set(idHex, buf);
    }
    buf.push({ t: performance.now(), x, y, facing: toFacing(facing) });
  };

  const handleRemote = (idHex: string, name: string, x: number, y: number, facing: number) => {
    names.set(idHex, name);
    record(idHex, x, y, facing);
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
        handleRemote(idHex, row.name, row.x, row.y, row.facing);
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
        handleRemote(idHex, row.name, row.x, row.y, row.facing);
      });
      c.db.player.onUpdate((_ctx, _old, row) => {
        const idHex = row.identity.toHexString();
        if (idHex === myIdHex) {
          onAck(row);
          return;
        }
        handleRemote(idHex, row.name, row.x, row.y, row.facing);
      });
      c.db.player.onDelete((_ctx, row) => {
        const idHex = row.identity.toHexString();
        if (idHex === myIdHex) return;
        buffers.delete(idHex);
        names.delete(idHex);
        gameApp.removeRemotePlayer(idHex);
      });
    })
    .catch(() => {});

  // Render remote players interpolated INTERP_DELAY_MS in the past.
  gameApp.onFrame((now) => {
    const renderTime = now - INTERP_DELAY_MS;
    for (const [idHex, buf] of buffers) {
      prune(buf, now);
      if (buf.length === 0) continue;
      const s = sampleAt(buf, renderTime);
      gameApp.upsertRemotePlayer(idHex, names.get(idHex) ?? '', s.x, s.y, s.facing);
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

/** Drop samples older than the TTL, always keeping at least the last two. */
function prune(buf: Snapshot[], now: number): void {
  while (buf.length > 2 && now - buf[0].t > SNAPSHOT_TTL_MS) buf.shift();
}

/**
 * Returns the position at renderTime by linearly interpolating between the two
 * straddling snapshots. Clamps to the nearest snapshot outside the buffered
 * range (no extrapolation). facing comes from the later snapshot.
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
      const alpha = span > 0 ? (renderTime - a.t) / span : 0;
      return {
        t: renderTime,
        x: a.x + (b.x - a.x) * alpha,
        y: a.y + (b.y - a.y) * alpha,
        facing: b.facing,
      };
    }
  }
  return last;
}
