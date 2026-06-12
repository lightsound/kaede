import { MOB_STATS, SPAWN_X, SPAWN_Y, stateFromRow, xpToNext, type MobKind } from '@maple/shared';
import { DAMAGE_COLORS, type GameApp } from '../game/GameApp';
import type { DbConnection } from '../module_bindings';
import { connect } from './connection';
import { createPrediction } from './prediction';
import { createRemoteViews } from './remoteView';

/** The generated own/remote player row type (all columns). */
type PlayerRow =
  ReturnType<DbConnection['db']['player']['iter']> extends Iterator<infer R> ? R : never;

/** The generated mob row type (all columns). */
type MobRow = ReturnType<DbConnection['db']['mob']['iter']> extends Iterator<infer R> ? R : never;

export interface Net {
  dispose(): void;
  /** Request a display-name change; applied once connected (latest wins if called early). */
  setName(name: string): void;
}

/**
 * Wires the game to SpacetimeDB. The server is authoritative: the client sends
 * only inputs (batched through submit_inputs) and predicts locally, replaying
 * un-acked inputs whenever the authoritative row disagrees with our prediction.
 * Remote players AND mobs are rendered interpolated INTERP_DELAY_MS in the past
 * (mobs reuse the remote-view machinery, carrying their kind as the meta).
 */
export function startNet(gameApp: GameApp): Net {
  const remoteViews = createRemoteViews();
  // Mob views share the same interpolation/smoothing code; the meta payload is
  // the mob kind, which the draw callback needs to size/color the rectangle.
  const mobViews = createRemoteViews<MobKind>();
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

  // Track each mob's last-seen hp so the per-frame redraw (which only carries
  // interpolated position) can keep the HP bar / hidden state in sync, and so a
  // row UPDATE can detect a damage tick (hp decreased) vs. a respawn (hp up).
  const mobHp = new Map<string, number>();

  gameApp.onLocalTick((state, tick, packedInput) => {
    if (!prediction) return;
    prediction.onTick(state, tick, packedInput, performance.now());
  });

  // Render remote players and mobs interpolated INTERP_DELAY_MS in the past.
  gameApp.onFrame((now) => {
    remoteViews.renderFrame(now, gameApp.upsertRemotePlayer);
    mobViews.renderFrame(now, (idHex, _name, x, y, facing, kind) => {
      // The interpolated frame carries only position/facing; the live hp comes
      // from mobHp (kept current by the row handlers), so the rectangle's HP bar
      // and hidden/dead state stay correct between row updates.
      gameApp.upsertMob(Number(idHex), kind, x, y, facing, mobHp.get(idHex) ?? MOB_STATS[kind].maxHp);
    });
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
        gameApp.setHud(row.hp, row.maxHp, row.xp, xpToNext(row.level), row.level);
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
      const handleRemoteRow = (idHex: string, old: PlayerRow | undefined, row: PlayerRow) => {
        if (row.online) {
          remoteViews.record(idHex, row.name, row, performance.now(), undefined);
          // A remote swing is observable only as a cooldown jump (0 -> full) on
          // their authoritative row; render a slash at their interpolated spot.
          if (old && row.attackCooldown > old.attackCooldown) {
            gameApp.showRemoteSlash(idHex, row.facing < 0 ? -1 : 1);
          }
        } else {
          remoteViews.remove(idHex);
          gameApp.removeRemotePlayer(idHex);
        }
      };

      // Own-row UPDATE side effects: HUD + floating feedback. These react to the
      // AUTHORITATIVE row, not prediction, so HP/XP/level (which the client does
      // not predict) surface correctly. Note hp/xp-only updates do not advance
      // tick; prediction's ack path early-returns on them, undisturbed.
      const handleOwnFeedback = (old: PlayerRow, row: PlayerRow) => {
        gameApp.setHud(row.hp, row.maxHp, row.xp, xpToNext(row.level), row.level);

        // Contact damage: hp dropped. Float a red number at the player.
        if (row.hp < old.hp) {
          gameApp.spawnDamageNumber(row.x, row.y - 24, old.hp - row.hp, DAMAGE_COLORS.own);
        }
        // Death-respawn: the server full-heals AND teleports to spawn in one
        // update (so hp never appears <= 0 on the wire). A heal-to-max combined
        // with a teleport to the spawn point, at the same level, is a death.
        if (
          row.hp > old.hp &&
          row.hp === row.maxHp &&
          row.level === old.level &&
          row.x === SPAWN_X &&
          row.y === SPAWN_Y
        ) {
          gameApp.showDeathFlash();
        }
        // XP gain within the same level reads as "+N EXP".
        if (row.xp > old.xp && row.level === old.level) {
          gameApp.spawnDamageNumber(row.x, row.y - 24, row.xp - old.xp, DAMAGE_COLORS.exp);
        }
        // Level-up: xp rebases onto the new curve (delta isn't a clean gain), so
        // show the flash rather than a misleading number.
        if (row.level > old.level) gameApp.showLevelUp();
      };

      // --- Mobs: buffer snapshots for interpolation; surface hp changes.
      const handleMobInsert = (row: MobRow) => {
        const idHex = String(row.id);
        mobHp.set(idHex, row.hp);
        mobViews.record(idHex, idHex, mobSnap(row), performance.now(), row.kind as MobKind);
      };
      const handleMobUpdate = (old: MobRow, row: MobRow) => {
        const idHex = String(row.id);
        mobHp.set(idHex, row.hp);
        mobViews.record(idHex, idHex, mobSnap(row), performance.now(), row.kind as MobKind);
        // hp dropped: a hit landed — float the damage at the mob's rendered spot.
        if (row.hp < old.hp && old.hp > 0) {
          gameApp.spawnDamageNumber(row.x, row.y - 16, old.hp - row.hp, DAMAGE_COLORS.mob);
        }
        // Death / respawn visibility is handled by upsertMob via the hp we pass
        // each frame (mobHp map); nothing extra needed here.
      };
      const handleMobDelete = (row: MobRow) => {
        const idHex = String(row.id);
        mobHp.delete(idHex);
        mobViews.remove(idHex);
        gameApp.removeMob(row.id);
      };

      // Seed players already in the world. A leftover own row may be our stale
      // offline row from a prior session; handleOwnRow ignores it (only the
      // post-join online row starts the sim).
      for (const row of c.db.player.iter()) {
        const idHex = row.identity.toHexString();
        if (idHex === myIdHex) handleOwnRow(row);
        else handleRemoteRow(idHex, undefined, row);
      }
      for (const row of c.db.mob.iter()) handleMobInsert(row);

      c.db.player.onInsert((_ctx, row) => {
        const idHex = row.identity.toHexString();
        if (idHex === myIdHex) {
          handleOwnRow(row);
          return;
        }
        handleRemoteRow(idHex, undefined, row);
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
          handleOwnFeedback(old, row);
          prediction.onAck(stateFromRow(row), row.tick, performance.now());
          return;
        }
        handleRemoteRow(idHex, old, row);
      });
      c.db.player.onDelete((_ctx, row) => {
        const idHex = row.identity.toHexString();
        if (idHex === myIdHex) return;
        remoteViews.remove(idHex);
        gameApp.removeRemotePlayer(idHex);
      });

      c.db.mob.onInsert((_ctx, row) => handleMobInsert(row));
      c.db.mob.onUpdate((_ctx, old, row) => handleMobUpdate(old, row));
      c.db.mob.onDelete((_ctx, row) => handleMobDelete(row));

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

/**
 * A mob row as an interpolation snapshot. The server moves mobs by dir * speed,
 * so we reconstruct that velocity as the Hermite tangent; vy is always 0.
 */
function mobSnap(row: MobRow) {
  const speed = MOB_STATS[row.kind as MobKind].speed;
  return { x: row.x, y: row.y, vx: row.dir * speed, vy: 0, facing: row.dir };
}
