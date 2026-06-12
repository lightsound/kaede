import { schema, table, t } from 'spacetimedb/server';

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
      online: t.bool(), // connection presence: rows persist across disconnects
      tick: t.u32(), // ticks applied so far; state is "after tick `tick`"
      simStartAt: t.timestamp(), // spawn wall-clock, basis of the speed-hack guard
      updatedAt: t.timestamp(),
    }
  ),
});
