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

      // Find our own row and start the simulation from the authoritative spawn
      // state. Other rows already in the cache are seeded as remote players.
      let ownRow: PlayerRow | undefined;
      for (const row of c.db.player.iter()) {
        const idHex = row.identity.toHexString();
        if (idHex === myIdHex) {
          ownRow = row;
          continue;
        }
        remoteViews.record(idHex, row.name, row, performance.now());
      }
      if (ownRow) {
        gameApp.setLocalPlayerName(ownRow.name);
        prediction = createPrediction(
          {
            sendBatch(startTick, packed) {
              conn?.reducers.submitInputs({ startTick, inputs: packed }).catch(() => {});
            },
            resetLocal(state, tick) {
              gameApp.resetLocal(state, tick);
            },
          },
          ownRow.tick,
        );
        gameApp.start(stateFromRow(ownRow), ownRow.tick);
      }

      c.db.player.onInsert((_ctx, row) => {
        const idHex = row.identity.toHexString();
        if (idHex === myIdHex) return;
        remoteViews.record(idHex, row.name, row, performance.now());
      });
      c.db.player.onUpdate((_ctx, _old, row) => {
        const idHex = row.identity.toHexString();
        if (idHex === myIdHex) {
          // An own-row update IS the acknowledgement (row.tick = applied count).
          prediction?.onAck(stateFromRow(row), row.tick, performance.now());
          return;
        }
        remoteViews.record(idHex, row.name, row, performance.now());
      });
      c.db.player.onDelete((_ctx, row) => {
        const idHex = row.identity.toHexString();
        if (idHex === myIdHex) return;
        remoteViews.remove(idHex);
        gameApp.removeRemotePlayer(idHex);
      });
    })
    .catch(() => {});

  return {
    dispose() {
      disposed = true;
      conn?.disconnect();
      conn = undefined;
    },
  };
}
