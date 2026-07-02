import { stateFromRow } from '@maple/shared';
import type { GameApp } from '../game/GameApp';
import type { DbConnection } from '../module_bindings';
import { connect } from './connection';
import { createPrediction } from './prediction';
import { createRemoteViews } from './remoteView';

/** The generated own/remote player row type (all columns). */
type PlayerRow =
  ReturnType<DbConnection['db']['player']['iter']> extends Iterator<infer R> ? R : never;

type Prediction = ReturnType<typeof createPrediction>;
type RemoteViews = ReturnType<typeof createRemoteViews>;

/** What the user should be told about the connection right now. */
export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting';

/** First retry delay after a failure; doubles per attempt up to the max. */
const RETRY_INITIAL_MS = 1000;
const RETRY_MAX_MS = 30_000;

export interface Net {
  dispose(): void;
}

/** Everything a wired session needs from the surrounding startNet scope. */
interface SessionCtx {
  gameApp: GameApp;
  remoteViews: RemoteViews;
  getPrediction(): Prediction | undefined;
  setPrediction(p: Prediction): void;
  sendBatch(startTick: number, packed: Uint8Array): void;
}

/**
 * Our row appeared (or already existed, when resuming an identity) via join.
 * Start/refresh the simulation from that authoritative state, once.
 */
function handleOwnRow(row: PlayerRow, ctx: SessionCtx): void {
  if (ctx.getPrediction()) return;
  ctx.gameApp.setLocalPlayerName(row.name);
  ctx.setPrediction(
    createPrediction(
      {
        sendBatch: ctx.sendBatch,
        resetLocal(state, tick) {
          ctx.gameApp.resetLocal(state, tick);
        },
      },
      row.tick,
    ),
  );
  ctx.gameApp.start(stateFromRow(row), row.tick);
}

/**
 * Offline rows linger server-side for the retention window (so their owner
 * can resume) but should not be visible in the world.
 */
function recordRemote(idHex: string, row: PlayerRow, ctx: SessionCtx): void {
  if (!row.online) {
    removeRemote(idHex, ctx);
    return;
  }
  ctx.remoteViews.record(
    idHex,
    row.name,
    { ...row, updatedAtMs: Number(row.updatedAt.toMillis()) },
    performance.now(),
  );
}

function removeRemote(idHex: string, ctx: SessionCtx): void {
  ctx.remoteViews.remove(idHex);
  ctx.gameApp.removeRemotePlayer(idHex);
}

/** Route every player row (seed + live changes) to the own/remote handlers. */
function wireSession(c: DbConnection, myIdHex: string, ctx: SessionCtx): void {
  const route = (row: PlayerRow) => {
    const idHex = row.identity.toHexString();
    if (idHex === myIdHex) handleOwnRow(row, ctx);
    else recordRemote(idHex, row, ctx);
  };

  // Seed players already in the world (an existing own row means we resumed
  // our identity after a reload/blip; continue from it rather than re-spawn).
  for (const row of c.db.player.iter()) route(row);

  c.db.player.onInsert((_ctx, row) => route(row));
  c.db.player.onUpdate((_ctx, _old, row) => {
    const idHex = row.identity.toHexString();
    if (idHex === myIdHex) {
      // An own-row update IS the acknowledgement (row.tick = applied count).
      ctx.getPrediction()?.onAck(stateFromRow(row), row.tick, performance.now());
      return;
    }
    recordRemote(idHex, row, ctx);
  });
  c.db.player.onDelete((_ctx, row) => {
    const idHex = row.identity.toHexString();
    if (idHex !== myIdHex) removeRemote(idHex, ctx);
  });
}

/**
 * Retries connect() forever with exponential backoff, reporting status.
 * onSession fires per successful connection; onDrop fires when it is lost.
 */
function startConnectLoop(opts: {
  onStatus: (status: ConnectionStatus) => void;
  onSession: (c: DbConnection, myIdHex: string) => void;
  onDrop: () => void;
}): { dispose(): void } {
  let disposed = false;
  let everConnected = false;
  let conn: DbConnection | undefined;
  let retryDelayMs = RETRY_INITIAL_MS;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  function scheduleRetry(): void {
    if (disposed) return;
    opts.onStatus(everConnected ? 'reconnecting' : 'connecting');
    retryTimer = setTimeout(attempt, retryDelayMs);
    retryDelayMs = Math.min(retryDelayMs * 2, RETRY_MAX_MS);
  }

  function attempt(): void {
    if (disposed) return;
    opts.onStatus(everConnected ? 'reconnecting' : 'connecting');
    connect({
      onDisconnect() {
        if (disposed) return;
        conn = undefined;
        opts.onDrop();
        scheduleRetry();
      },
    })
      .then(({ conn: c, myIdHex }) => {
        if (disposed) {
          c.disconnect();
          return;
        }
        conn = c;
        everConnected = true;
        retryDelayMs = RETRY_INITIAL_MS;
        opts.onStatus('connected');
        opts.onSession(c, myIdHex);
        c.reducers.join({}).catch(() => {});
      })
      .catch(() => scheduleRetry());
  }

  attempt();

  return {
    dispose() {
      disposed = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      conn?.disconnect();
      conn = undefined;
    },
  };
}

/**
 * Wires the game to SpacetimeDB. The server is authoritative: the client sends
 * only inputs (batched through submit_inputs) and predicts locally, replaying
 * un-acked inputs whenever the authoritative row disagrees with our prediction.
 * Remote players are rendered interpolated INTERP_DELAY_MS in the past.
 *
 * Connection failures and drops are retried forever with exponential backoff;
 * `onStatus` keeps the UI informed. On reconnect the tab resumes its identity
 * (see connection.ts), so the server hands back the same player row and the
 * local sim snaps to that authoritative state.
 */
export function startNet(gameApp: GameApp, onStatus: (status: ConnectionStatus) => void): Net {
  const remoteViews = createRemoteViews();

  // Prediction lives per connection: it is created once the authoritative own
  // row is known, and torn down (with the remote views) when the connection
  // drops. The local sim keeps running while offline; reconnecting snaps it
  // back to the authoritative row.
  let prediction: Prediction | undefined;
  let conn: DbConnection | undefined;

  gameApp.onLocalTick((state, tick, packedInput) => {
    prediction?.onTick(state, tick, packedInput, performance.now());
  });

  // Render remote players interpolated INTERP_DELAY_MS in the past.
  gameApp.onFrame((now) => {
    remoteViews.renderFrame(now, gameApp.upsertRemotePlayer);
  });

  const ctx: SessionCtx = {
    gameApp,
    remoteViews,
    getPrediction: () => prediction,
    setPrediction(p) {
      prediction = p;
    },
    sendBatch(startTick, packed) {
      conn?.reducers.submitInputs({ startTick, inputs: packed }).catch(() => {});
    },
  };

  const loop = startConnectLoop({
    onStatus,
    onSession(c, myIdHex) {
      conn = c;
      wireSession(c, myIdHex, ctx);
    },
    onDrop() {
      prediction = undefined;
      conn = undefined;
      remoteViews.clear();
      gameApp.clearRemotePlayers();
    },
  });

  return {
    dispose() {
      loop.dispose();
    },
  };
}
