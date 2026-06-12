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
      updatedAt: t.timestamp(),
    }
  ),
});
