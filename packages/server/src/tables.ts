import { schema, t, table } from 'spacetimedb/server';

export const spacetimedb = schema({
  player: table(
    { name: 'player', public: true },
    {
      identity: t.identity().primaryKey(),
      name: t.string(),
      x: t.number(),
      y: t.number(),
      vx: t.number(),
      vy: t.number(),
      facing: t.i8(), // -1 left, 1 right
      onGround: t.bool(),
      rope: t.i32(), // rope index while climbing, -1 = none
      tick: t.u32(), // ticks applied so far; state is "after tick `tick`"
      online: t.bool(), // false between disconnect and rejoin/sweep; hidden by clients
      allowanceMicros: t.i64(), // token-bucket marker of the speed-hack guard (micros since epoch)
      updatedAt: t.timestamp(),
    },
  ),
});
