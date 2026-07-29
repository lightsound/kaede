// fallow-ignore-file coverage-gaps -- SpacetimeDB reducers run inside the module host; the pure logic they call lives in @maple/shared and is unit-tested there
import {
  DEFAULT_MAP,
  evaluateInputBatch,
  OFFLINE_RETENTION_MS,
  replayInputs,
  SPAWN_X,
  SPAWN_Y,
  stateFromRow,
} from '@maple/shared';
import { type InferSchema, type ReducerCtx, t } from 'spacetimedb/server';
import { spacetimedb } from './tables';

/** The reducer context for this module's schema, for helpers that touch the db. */
type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;

/**
 * Records why a batch was refused. `stale-tick` is the resend watchdog's normal
 * duplicate path, so it is not noteworthy.
 */
function logRejection(
  reason: string,
  sender: string,
  startTick: number,
  length: number,
  rowTick: number,
): void {
  if (reason === 'stale-tick') return;
  console.warn(
    `submit_inputs rejected (${reason}): sender=${sender} startTick=${startTick} len=${length} rowTick=${rowTick}`,
  );
}

// Server-authoritative movement: clients send only inputs, the server replays
// them through the same shared physics. Position cannot change any other way.
// Admission (batch size, ordering, token-bucket rate limit) lives in the pure
// evaluateInputBatch so it is unit-tested in @maple/shared.
export const submitInputs = spacetimedb.reducer(
  { startTick: t.u32(), inputs: t.array(t.u8()) },
  (ctx, { startTick, inputs }) => {
    const row = ctx.db.player.identity.find(ctx.sender);
    if (!row) return;

    const verdict = evaluateInputBatch({
      batchLength: inputs.length,
      startTick,
      rowTick: row.tick,
      allowanceMicros: row.allowanceMicros,
      nowMicros: ctx.timestamp.microsSinceUnixEpoch,
    });
    if (!verdict.ok) {
      logRejection(verdict.reason, ctx.sender.toHexString(), startTick, inputs.length, row.tick);
      return;
    }

    const s = replayInputs(stateFromRow(row), inputs, DEFAULT_MAP);

    ctx.db.player.identity.update({
      ...row,
      x: s.x,
      y: s.y,
      vx: s.vx,
      vy: s.vy,
      facing: s.facing,
      onGround: s.onGround,
      rope: s.rope,
      tick: row.tick + inputs.length,
      online: true, // a stale disconnect event may have raced us; inputs prove liveness
      allowanceMicros: verdict.allowanceMicros,
      updatedAt: ctx.timestamp,
    });
  },
);

/** True once a disconnected player's row has sat past its retention window. */
function isExpiredOffline(online: boolean, ageMs: number): boolean {
  return !online && ageMs > OFFLINE_RETENTION_MS;
}

/**
 * Deletes offline rows whose retention window has elapsed. Identities are
 * collected first so nothing is removed out from under the iterator.
 */
function sweepExpiredOfflineRows(ctx: Ctx): void {
  const stale = [];
  for (const row of ctx.db.player.iter()) {
    if (isExpiredOffline(row.online, ctx.timestamp.since(row.updatedAt).millis)) {
      stale.push(row.identity);
    }
  }
  for (const identity of stale) ctx.db.player.identity.delete(identity);
}

// Spawning is an explicit opt-in, not a connection side effect: observer
// connections (spacetime sql/subscribe, admin tooling) never call join, so
// they no longer flash into the world as phantom players.
export const join = spacetimedb.reducer((ctx) => {
  sweepExpiredOfflineRows(ctx);

  const existing = ctx.db.player.identity.find(ctx.sender);
  if (existing) {
    // Reload / network blip within the retention window: resume the saved
    // character where it stood, with a fresh input allowance.
    ctx.db.player.identity.update({
      ...existing,
      online: true,
      allowanceMicros: ctx.timestamp.microsSinceUnixEpoch,
      updatedAt: ctx.timestamp,
    });
    return;
  }

  const name = `Player-${ctx.sender.toHexString().slice(0, 6)}`;
  ctx.db.player.insert({
    identity: ctx.sender,
    name,
    x: SPAWN_X,
    y: SPAWN_Y,
    vx: 0,
    vy: 0,
    facing: 1,
    onGround: false,
    rope: -1,
    tick: 0,
    online: true,
    allowanceMicros: ctx.timestamp.microsSinceUnixEpoch,
    updatedAt: ctx.timestamp,
  });
});

// Keep the row on disconnect (marked offline) so a quick reconnect under the
// same identity resumes the character; join sweeps rows past their retention.
export const onDisconnect = spacetimedb.clientDisconnected((ctx) => {
  const row = ctx.db.player.identity.find(ctx.sender);
  if (!row) return;
  ctx.db.player.identity.update({ ...row, online: false, updatedAt: ctx.timestamp });
});
