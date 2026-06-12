import { t } from 'spacetimedb/server';
import { SPAWN_X, SPAWN_Y } from '@maple/shared';
import { spacetimedb } from './tables';

// Trust-based MVP: no server-side physics validation. The sender can only ever
// write its own row, enforced by keying on ctx.sender (never an identity param).
export const updatePosition = spacetimedb.reducer(
  { x: t.number(), y: t.number(), vx: t.number(), vy: t.number(), facing: t.i8() },
  (ctx, { x, y, vx, vy, facing }) => {
    const row = ctx.db.player.identity.find(ctx.sender);
    if (!row) return;
    ctx.db.player.identity.update({ ...row, x, y, vx, vy, facing, updatedAt: ctx.timestamp });
  }
);

export const onConnect = spacetimedb.clientConnected(ctx => {
  if (ctx.db.player.identity.find(ctx.sender)) return;
  const name = 'Player-' + ctx.sender.toHexString().slice(0, 6);
  ctx.db.player.insert({
    identity: ctx.sender,
    name,
    x: SPAWN_X,
    y: SPAWN_Y,
    vx: 0,
    vy: 0,
    facing: 1,
    updatedAt: ctx.timestamp,
  });
});

export const onDisconnect = spacetimedb.clientDisconnected(ctx => {
  ctx.db.player.identity.delete(ctx.sender);
});
