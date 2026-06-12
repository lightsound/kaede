import { stateFromRow } from '@maple/shared';
import type { GameApp } from '../game/GameApp';
import type { DbConnection } from '../module_bindings';
import { connect } from './connection';
import { createPrediction } from './prediction';
import { createRemoteViews } from './remoteView';

/** The generated own/remote player row type (all columns). */
type PlayerRow =
  ReturnType<DbConnection['db']['player']['iter']> extends Iterator<infer R> ? R : never;

export interface Net {
  dispose(): void;
  /** Request a display-name change; applied once connected (latest wins if called early). */
  setName(name: string): void;
}

/**
 * Wires the game to SpacetimeDB. The server is authoritative: the client sends
 * only inputs (batched through submit_inputs) and predicts locally, replaying
 * un-acked inputs whenever the authoritative row disagrees with our prediction.
 * Remote players are rendered interpolated INTERP_DELAY_MS in the past.
 */
export function startNet(gameApp: GameApp): Net {
  const remoteViews = createRemoteViews();
  let conn: DbConnection | undefined;
  let myIdHex = '';
  let disposed = false;

  // Prediction is created once the authoritative own row is known (the sim
  // doesn't tick before start() anyway, mirroring today's `if (!conn) return`).
  let prediction: ReturnType<typeof createPrediction> | undefined;

  // Latch a name requested before the connection resolves; applied after join.
  let pendingName: string | undefined;
  function applyName(name: string): void {
    conn?.reducers.setName({ name }).catch(() => {});
  }

  gameApp.onLocalTick((state, tick, packedInput) => {
    if (!prediction) return;
    prediction.onTick(state, tick, packedInput, performance.now());
  });

  // Render remote players interpolated INTERP_DELAY_MS in the past.
  gameApp.onFrame((now) => {
    remoteViews.renderFrame(now, gameApp.upsertRemotePlayer);
  });

  connect()
    .then(({ conn: c, myIdHex: id }) => {
      if (disposed) {
        c.disconnect();
        return;
      }
      conn = c;
      myIdHex = id;

      // Start the simulation from the authoritative spawn state. Only an ONLINE
      // own row is a valid sim start: after a reconnect the subscription cache
      // still holds our previous row (online=false, stale tick), and starting
      // prediction from that would corrupt the tick basis. join resets the row
      // to online=true with tick=0, and that update is what we start from.
      const handleOwnRow = (row: PlayerRow) => {
        if (prediction || !row.online) return;
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
        // Apply any name requested before we were ready (latest request wins).
        if (pendingName !== undefined) {
          applyName(pendingName);
          pendingName = undefined;
        }
      };

      // Remote presence: a row only represents a player in the world while it is
      // online. Buffer online rows; drop the view the moment a row goes offline.
      const handleRemoteRow = (idHex: string, row: PlayerRow) => {
        if (row.online) {
          remoteViews.record(idHex, row.name, row, performance.now());
        } else {
          remoteViews.remove(idHex);
          gameApp.removeRemotePlayer(idHex);
        }
      };

      // Seed players already in the world. A leftover own row may be our stale
      // offline row from a prior session; handleOwnRow ignores it (only the
      // post-join online row starts the sim).
      for (const row of c.db.player.iter()) {
        const idHex = row.identity.toHexString();
        if (idHex === myIdHex) handleOwnRow(row);
        else handleRemoteRow(idHex, row);
      }

      c.db.player.onInsert((_ctx, row) => {
        const idHex = row.identity.toHexString();
        if (idHex === myIdHex) {
          handleOwnRow(row);
          return;
        }
        handleRemoteRow(idHex, row);
      });
      c.db.player.onUpdate((_ctx, old, row) => {
        const idHex = row.identity.toHexString();
        if (idHex === myIdHex) {
          // A rejoin (reconnect under a persisted identity) arrives as an UPDATE,
          // not an insert, so before prediction exists we must treat the update
          // as the spawn (handleOwnRow gates on online). Once running, an own-row
          // update IS the acknowledgement (row.tick = applied count).
          if (!prediction) {
            handleOwnRow(row);
            return;
          }
          // Keep our label in sync after a setName ack (cheap: only on change).
          if (row.name !== old.name) gameApp.setLocalPlayerName(row.name);
          prediction.onAck(stateFromRow(row), row.tick, performance.now());
          return;
        }
        handleRemoteRow(idHex, row);
      });
      c.db.player.onDelete((_ctx, row) => {
        const idHex = row.identity.toHexString();
        if (idHex === myIdHex) return;
        remoteViews.remove(idHex);
        gameApp.removeRemotePlayer(idHex);
      });

      c.reducers.join({}).catch(() => {});
    })
    .catch(() => {});

  return {
    dispose() {
      disposed = true;
      conn?.disconnect();
      conn = undefined;
    },
    setName(name) {
      // Before join completes there's no row to name yet; latch the request so
      // handleOwnRow can apply it. Afterwards send it straight through.
      if (prediction) applyName(name);
      else pendingName = name;
    },
  };
}
