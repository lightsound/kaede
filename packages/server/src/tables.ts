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

/**
 * The mob_ai_timer row, declared ONCE with an explicit type name and shared by
 * the table below and mobTick's reducer parameter (reducers.ts). Publish-time
 * registration requires every compound reducer-parameter type to carry a type
 * name — an anonymous t.row(...) makes `spacetime publish` fail with
 * "Missing type name for RowBuilder". Sharing the instance also registers the
 * table row and the scheduled arg as the same type. 'MobAiTimer' matches what
 * the SDK would derive from the table name.
 */
export const mobAiTimerRow = t.row('MobAiTimer', {
  scheduledId: t.u64().primaryKey().autoInc(),
  scheduledAt: t.scheduleAt(),
});

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
      // Current map (index into MAPS). Part of the deterministic state: stepPlayer
      // switches it on portal travel, so the server replays map changes for free.
      // Placed right after invulnUntil — this IS the wire order the client binding
      // mirrors column-for-column.
      mapId: t.u16(),
      tick: t.u32(), // ticks applied so far; state is "after tick `tick`"
      simStartAt: t.timestamp(), // spawn wall-clock, basis of the speed-hack guard
      updatedAt: t.timestamp(),
    }
  ),

  // World chat. Public so every client streams the log; clients never write to
  // it directly (the sendMessage reducer is the only writer). The table is kept
  // pruned to the most recent 50 rows, which bounds storage AND makes it cheap
  // to scan for the sender's last sentAt (the rate limit, kept off the player
  // schema). `name` is a snapshot of the sender's display name at send time, so
  // later renames don't rewrite history.
  message: table(
    { name: 'message', public: true },
    {
      id: t.u64().primaryKey().autoInc(),
      sender: t.identity(),
      name: t.string(),
      text: t.string(),
      sentAt: t.timestamp(),
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
  mobAiTimer: table({ name: 'mob_ai_timer', scheduled: () => mobTickRef! }, mobAiTimerRow),
});
