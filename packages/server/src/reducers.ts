import { t } from 'spacetimedb/server';
import {
  DEFAULT_MAP,
  DT,
  INPUT_BATCH_MAX_TICKS,
  SPAWN_X,
  SPAWN_Y,
  TICK_ALLOWANCE_SLACK,
  stateFromRow,
  stepPlayer,
  unpackInput,
  type PlayerState,
} from '@maple/shared';
import { spacetimedb } from './tables';

// Server-authoritative movement: clients send only inputs, the server replays
// them through the same shared physics. Position cannot change any other way.
export const submitInputs = spacetimedb.reducer(
  { startTick: t.u32(), inputs: t.array(t.u8()) },
  (ctx, { startTick, inputs }) => {
    const row = ctx.db.player.identity.find(ctx.sender);
    if (!row) return;
    if (inputs.length === 0 || inputs.length > INPUT_BATCH_MAX_TICKS) return;
    if (startTick !== row.tick) return; // out-of-order / duplicate batch

    // Speed-hack guard: a player's tick count may run at most TICK_ALLOWANCE_SLACK
    // ticks ahead of the wall-clock ticks elapsed since spawn.
    const elapsedMs = ctx.timestamp.since(row.simStartAt).millis;
    const allowed = Math.floor(elapsedMs / (DT * 1000)) + TICK_ALLOWANCE_SLACK;
    if (row.tick + inputs.length > allowed) return;

    let s: PlayerState = stateFromRow(row);
    for (const byte of inputs) s = stepPlayer(s, unpackInput(byte), DEFAULT_MAP);

    ctx.db.player.identity.update({
      ...row,
      x: s.x,
      y: s.y,
      vx: s.vx,
      vy: s.vy,
      facing: s.facing,
      onGround: s.onGround,
      rope: s.rope,
      // Self-heal `online` here: a double-login-then-close race can land a
      // stale offline flag on a still-active identity. Any input proves we're
      // online, and we're already updating the row, so reassert it.
      online: true,
      tick: row.tick + inputs.length,
      updatedAt: ctx.timestamp,
    });
  }
);

// Spawning is an explicit opt-in, not a connection side effect: observer
// connections (spacetime sql/subscribe, admin tooling) never call join, so
// they no longer flash into the world as phantom players.
export const join = spacetimedb.reducer(ctx => {
  const row = ctx.db.player.identity.find(ctx.sender);
  if (row) {
    // Reconnect under a persisted identity: keep where they left off (x, y,
    // name, facing) but re-arm the speed-hack guard. Resetting tick to 0 with a
    // fresh simStartAt is REQUIRED — otherwise the wall-clock elapsed since the
    // original spawn would let the next batch burst far ahead of real time.
    ctx.db.player.identity.update({
      ...row,
      vx: 0,
      vy: 0,
      onGround: false,
      rope: -1,
      online: true,
      tick: 0,
      simStartAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
    });
    return;
  }
  const name = 'Player-' + ctx.sender.toHexString().slice(0, 6);
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
    online: true,
    tick: 0,
    simStartAt: ctx.timestamp,
    updatedAt: ctx.timestamp,
  });
});

// Presence, not deletion: the row persists so the player resumes from their
// last position on the next join. Only the online flag flips.
export const onDisconnect = spacetimedb.clientDisconnected(ctx => {
  const row = ctx.db.player.identity.find(ctx.sender);
  if (!row) return;
  ctx.db.player.identity.update({ ...row, online: false, updatedAt: ctx.timestamp });
});

// Player-chosen display name. Validation mirrors the client overlay's
// maxLength: a trimmed, control-character-free string of 1..16 chars.
export const setName = spacetimedb.reducer({ name: t.string() }, (ctx, { name }) => {
  const row = ctx.db.player.identity.find(ctx.sender);
  if (!row) return;
  const trimmed = name.trim();
  // eslint-disable-next-line no-control-regex
  if (trimmed.length === 0 || trimmed.length > 16 || /[\x00-\x1f\x7f]/.test(trimmed)) return;
  ctx.db.player.identity.update({ ...row, name: trimmed, updatedAt: ctx.timestamp });
});
