import { stateFromRow } from '@maple/shared';
import type { GameApp } from '../game/GameApp';
import type { DbConnection } from '../module_bindings';
import { connect } from './connection';
import { createPrediction } from './prediction';
import { createRemoteViews } from './remoteView';

/** The generated own/remote player row type (all columns). */
type PlayerRow =
  ReturnType<DbConnection['db']['player']['iter']> extends Iterator<infer R> ? R : never;

/** What the user should be told about the connection right now. */
export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting';

/** First retry delay after a failure; doubles per attempt up to the max. */
const RETRY_INITIAL_MS = 1000;
const RETRY_MAX_MS = 30_000;

export interface Net {
  dispose(): void;
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
  let conn: DbConnection | undefined;
  let disposed = false;
  let everConnected = false;
  let retryDelayMs = RETRY_INITIAL_MS;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  // Prediction lives per connection: it is created once the authoritative own
  // row is known, and torn down (with the remote views) when the connection
  // drops. The local sim keeps running while offline; reconnecting snaps it
  // back to the authoritative row.
  let prediction: ReturnType<typeof createPrediction> | undefined;

  gameApp.onLocalTick((state, tick, packedInput) => {
    if (!prediction) return;
    prediction.onTick(state, tick, packedInput, performance.now());
  });

  // Render remote players interpolated INTERP_DELAY_MS in the past.
  gameApp.onFrame((now) => {
    remoteViews.renderFrame(now, gameApp.upsertRemotePlayer);
  });

  function dropSession(): void {
    prediction = undefined;
    conn = undefined;
    remoteViews.clear();
    gameApp.clearRemotePlayers();
  }

  function scheduleRetry(): void {
    if (disposed) return;
    onStatus(everConnected ? 'reconnecting' : 'connecting');
    retryTimer = setTimeout(attempt, retryDelayMs);
    retryDelayMs = Math.min(retryDelayMs * 2, RETRY_MAX_MS);
  }

  function wireSession(c: DbConnection, myIdHex: string): void {
    // Our row appears (or already exists, when resuming an identity) via join
    // below. Start/refresh the simulation from that authoritative state.
    const handleOwnRow = (row: PlayerRow) => {
      if (prediction) return;
      gameApp.setLocalPlayerName(row.name);
      prediction = createPrediction(
        {
          sendBatch(startTick, packed) {
            conn?.reducers.submitInputs({ startTick, inputs: packed }).catch(() => {});
          },
          resetLocal(state, tick) {
            gameApp.resetLocal(state, tick);
          },
        },
        row.tick,
      );
      gameApp.start(stateFromRow(row), row.tick);
    };

    // Offline rows linger server-side for the retention window (so their owner
    // can resume) but should not be visible in the world.
    const recordRemote = (idHex: string, row: PlayerRow) => {
      if (!row.online) {
        remoteViews.remove(idHex);
        gameApp.removeRemotePlayer(idHex);
        return;
      }
      remoteViews.record(
        idHex,
        row.name,
        { ...row, updatedAtMs: Number(row.updatedAt.toMillis()) },
        performance.now(),
      );
    };

    // Seed players already in the world (an existing own row means we resumed
    // our identity after a reload/blip; continue from it rather than re-spawn).
    for (const row of c.db.player.iter()) {
      const idHex = row.identity.toHexString();
      if (idHex === myIdHex) handleOwnRow(row);
      else recordRemote(idHex, row);
    }

    c.db.player.onInsert((_ctx, row) => {
      const idHex = row.identity.toHexString();
      if (idHex === myIdHex) {
        handleOwnRow(row);
        return;
      }
      recordRemote(idHex, row);
    });
    c.db.player.onUpdate((_ctx, _old, row) => {
      const idHex = row.identity.toHexString();
      if (idHex === myIdHex) {
        // An own-row update IS the acknowledgement (row.tick = applied count).
        prediction?.onAck(stateFromRow(row), row.tick, performance.now());
        return;
      }
      recordRemote(idHex, row);
    });
    c.db.player.onDelete((_ctx, row) => {
      const idHex = row.identity.toHexString();
      if (idHex === myIdHex) return;
      remoteViews.remove(idHex);
      gameApp.removeRemotePlayer(idHex);
    });
  }

  function attempt(): void {
    if (disposed) return;
    onStatus(everConnected ? 'reconnecting' : 'connecting');
    connect({
      onDisconnect() {
        if (disposed) return;
        dropSession();
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
        onStatus('connected');
        wireSession(c, myIdHex);
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
