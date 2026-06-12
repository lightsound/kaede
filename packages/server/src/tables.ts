import { schema, table, t, type ReducerExport } from 'spacetimedb/server';

/**
 * Lazy forward reference to the scheduled mob-AI reducer. reducers.ts assigns it
 * at module-eval time; the `scheduled` thunk below reads it only at schema
 * registration (after every module has evaluated), so we avoid a hard
 * tables.ts <-> reducers.ts import cycle. (Importing mobTick eagerly here would
 * TDZ-crash: reducers.ts needs `spacetimedb` from this file at its own top
 * level, so neither const can be the one defined first.)
 */
let mobTickRef: ReducerExport<any, any> | undefined;
export function setMobTick(reducer: ReducerExport<any, any>): void {
  mobTickRef = reducer;
}

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
      // --- Combat / progression. Order matters: it is the wire format the
      // hand-maintained client bindings mirror column-for-column.
      hp: t.i32(),
      maxHp: t.i32(),
      xp: t.u32(),
      level: t.u16(),
      attackCooldown: t.u16(), // ticks until the next swing is allowed (0 = ready)
      invulnUntil: t.timestamp(), // contact damage is ignored until this instant
      tick: t.u32(), // ticks applied so far; state is "after tick `tick`"
      simStartAt: t.timestamp(), // spawn wall-clock, basis of the speed-hack guard
      updatedAt: t.timestamp(),
    }
  ),

  // Server-driven monsters. Public so clients can render them interpolated (the
  // same way they render remote players); clients never write to it.
  mob: table(
    { name: 'mob', public: true },
    {
      id: t.u32().primaryKey().autoInc(),
      kind: t.string(), // MobKind
      x: t.number(),
      y: t.number(),
      dir: t.i8(), // patrol direction, -1 / 1
      hp: t.i32(), // <= 0 means dead (awaiting respawn)
      spawnIdx: t.u16(), // index into MOB_SPAWNS; ties the row to its patrol home
      respawnAt: t.timestamp(), // when a dead mob comes back
      updatedAt: t.timestamp(),
    }
  ),

  // Private scheduled table that drives mob AI at MOB_TICK_MS. The `scheduled`
  // thunk resolves mobTick lazily through mobTickRef (see above); it's only
  // invoked at schema registration, after both modules have evaluated. Private
  // by default: clients must not see or call the timer.
  mobAiTimer: table(
    { name: 'mob_ai_timer', scheduled: () => mobTickRef! },
    {
      scheduledId: t.u64().primaryKey().autoInc(),
      scheduledAt: t.scheduleAt(),
    }
  ),
});
