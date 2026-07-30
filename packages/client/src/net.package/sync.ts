// fallow-ignore-file coverage-gaps -- wires a live SpacetimeDB connection to the game loop; needs a running host
import { stateFromRow } from '@maple/shared';
import type { GameApp } from '../game.package';
import type { DbConnection } from '../module_bindings';
import { type AuthTokenGetter, connect, target } from './connection';
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
  /**
   * Asks the server to rename this player (set_display_name). The result
   * arrives as an own-row update, which is also the caller's success signal.
   * Failures (a disconnect racing the submit, a server rejection) only log:
   * the form keeps its draft, so the user can see the label didn't change
   * and resubmit.
   */
  setDisplayName(name: string): void;
}

/**
 * Wires the game to SpacetimeDB. The server is authoritative: the client sends
 * only inputs (batched through submit_inputs) and predicts locally, replaying
 * un-acked inputs whenever the authoritative row disagrees with our prediction.
 * Remote players are rendered interpolated INTERP_DELAY_MS in the past.
 *
 * Connection failures and drops are retried forever with exponential backoff;
 * `onStatus` keeps the UI informed. On reconnect the identity is resumed —
 * via a fresh OIDC token from `getAuthToken` when signed in, or this tab's
 * stored anonymous token otherwise (see connection.ts) — so the server hands
 * back the same player row and the local sim snaps to that authoritative state.
 */
export function startNet(
  gameApp: GameApp,
  onStatus: (status: ConnectionStatus) => void,
  getAuthToken: AuthTokenGetter,
): Net {
  const remoteViews = createRemoteViews();
  let conn: DbConnection | undefined;
  let disposed = false;
  let everConnected = false;
  let retryDelayMs = RETRY_INITIAL_MS;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  // Connects that have failed in a row since the last success; connect() uses
  // it to decide when the stored identity token has become the likely culprit.
  let consecutiveFailures = 0;

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

  /** Ask the server to spawn or resume our row; the answer arrives as a row event. */
  function joinWorld(c: DbConnection): void {
    // A rejected join leaves us connected but never spawned, which on screen is
    // indistinguishable from a stalled connection. Say so.
    c.reducers.join({}).catch((err: unknown) => {
      console.error('SpacetimeDB: join failed, this client will not spawn', err);
    });
  }

  /**
   * Arms the next attempt, at most once per failure. A failed connect both
   * rejects and closes the socket, so this is called twice for the same
   * failure; without the guard the backoff doubled twice per round (1s, 4s,
   * 16s...) and each extra timer was dropped from retryTimer unreferenced.
   */
  function scheduleRetry(): void {
    if (disposed || retryTimer !== undefined) return;
    onStatus(everConnected ? 'reconnecting' : 'connecting');
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      attempt();
    }, retryDelayMs);
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
            // Batches lost to a dropping connection are expected and already
            // recovered by the resend watchdog, so a per-batch failure is not
            // worth reporting; logging one per flush would bury everything else.
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
        // The row also carries the display name, which a set_display_name
        // round trip may just have changed.
        gameApp.setLocalPlayerName(row.name);
        return;
      }
      recordRemote(idHex, row);
    });
    c.db.player.onDelete((_ctx, row) => {
      const idHex = row.identity.toHexString();
      if (idHex === myIdHex) {
        // The retention sweep reclaimed our row: a backgrounded tab stops
        // ticking, so it stops refreshing the row and eventually looks
        // abandoned. Re-join and let the replacement row restart prediction,
        // rather than predicting forward against a row that no longer exists.
        prediction = undefined;
        joinWorld(c);
        return;
      }
      remoteViews.remove(idHex);
      gameApp.removeRemotePlayer(idHex);
    });
  }

  function attempt(): void {
    if (disposed) return;
    onStatus(everConnected ? 'reconnecting' : 'connecting');
    connect(
      {
        onDisconnect() {
          if (disposed) return;
          console.warn('SpacetimeDB: connection dropped, reconnecting');
          dropSession();
          scheduleRetry();
        },
      },
      consecutiveFailures,
      getAuthToken,
    )
      .then(({ conn: c, myIdHex }) => {
        if (disposed) {
          c.disconnect();
          return;
        }
        conn = c;
        everConnected = true;
        consecutiveFailures = 0;
        retryDelayMs = RETRY_INITIAL_MS;
        onStatus('connected');
        wireSession(c, myIdHex);
        joinWorld(c);
      })
      // The overlay can only ever say "connecting", so without this the actual
      // cause (host not running, unknown database name, stale schema) never
      // reaches anyone. Naming the target makes the common misconfigurations
      // self-evident from the first line of the log.
      .catch((err: unknown) => {
        consecutiveFailures += 1;
        console.error(
          `SpacetimeDB: connection to ${target} failed, retrying in ${retryDelayMs}ms`,
          err,
        );
        scheduleRetry();
      });
  }

  attempt();

  return {
    dispose() {
      disposed = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      conn?.disconnect();
      conn = undefined;
    },
    setDisplayName(name) {
      if (!conn) {
        console.warn('SpacetimeDB: not connected, display name change dropped');
        return;
      }
      conn.reducers.setDisplayName({ name }).catch((err: unknown) => {
        console.error('SpacetimeDB: set_display_name rejected', err);
      });
    },
  };
}
