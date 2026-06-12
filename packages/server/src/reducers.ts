import { ScheduleAt, Timestamp } from 'spacetimedb';
import { t, type InferSchema, type ReducerCtx, type ReducerExport } from 'spacetimedb/server';
import {
  DT,
  INPUT_BATCH_MAX_TICKS,
  MAPS,
  MOB_RESPAWN_MS,
  MOB_STATS,
  MOB_SPAWNS,
  MOB_TICK_MS,
  PLAYER_HALF_H,
  PLAYER_HALF_W,
  PLAYER_INVULN_MS,
  SPAWN_X,
  SPAWN_Y,
  TICK_ALLOWANCE_SLACK,
  attackDamage,
  attackFires,
  maxHpForLevel,
  mobBox,
  overlaps,
  resolveAttackTarget,
  stateFromRow,
  stepMobPatrol,
  stepPlayer,
  unpackInput,
  xpToNext,
  type MobKind,
  type PlayerState,
} from '@maple/shared';
import { setMobTick, spacetimedb } from './tables';

type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;

/** A full message row, as iterated from the table (used by the prune scan). */
type MessageRow = ReturnType<Ctx['db']['message']['insert']>;

/** A future instant `ms` milliseconds after `from`. (Timestamp has no add().) */
function plusMillis(from: Timestamp, ms: number): Timestamp {
  return new Timestamp(from.microsSinceUnixEpoch + BigInt(ms) * 1000n);
}

/**
 * Trimmed user text that is non-empty, within `maxLen`, and free of control
 * characters. Shared by setName and sendMessage so both reject the same garbage
 * (and so the regex lives in exactly one place). Returns the trimmed string, or
 * undefined to reject. Mirrors the client overlays' maxLength.
 */
function validateText(raw: string, maxLen: number): string | undefined {
  const trimmed = raw.trim();
  // eslint-disable-next-line no-control-regex
  if (trimmed.length === 0 || trimmed.length > maxLen || /[\x00-\x1f\x7f]/.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

const MAX_NAME_LEN = 16;
const MAX_MESSAGE_LEN = 120;
// World chat is bounded to its most recent N rows: this caps storage AND keeps
// the rate-limit scan (newest sentAt per sender) cheap.
const MESSAGE_KEEP = 50;
// Minimum gap between one sender's messages, enforced by scanning the table.
const MESSAGE_MIN_GAP_MS = 500;

/**
 * Seed one mob row per MOB_SPAWNS entry, starting alive at full HP facing right.
 * Shared by `init` and the defensive reseed in mobTick so a republished DB whose
 * init never reran (or was wiped) still ends up with a populated world.
 */
function seedMobs(ctx: Ctx): void {
  for (let i = 0; i < MOB_SPAWNS.length; i++) {
    const s = MOB_SPAWNS[i];
    ctx.db.mob.insert({
      id: 0, // autoInc
      kind: s.kind,
      x: s.x,
      y: s.y,
      dir: 1,
      hp: MOB_STATS[s.kind].maxHp,
      spawnIdx: i,
      respawnAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
    });
  }
}

// Runs once when the module is first published: seed the mobs and arm the AI
// timer. Exported like any other reducer (index.ts does `export * from
// './reducers'`) so the lifecycle hook is registered.
export const init = spacetimedb.init((ctx) => {
  seedMobs(ctx);
  ctx.db.mobAiTimer.insert({
    scheduledId: 0n, // autoInc
    scheduledAt: ScheduleAt.interval(BigInt(MOB_TICK_MS) * 1000n),
  });
});

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

    // Combat is replayed inline with movement so a swing's hit is decided on the
    // exact tick it fired. hp/xp/level mutate locally and persist with the final
    // movement state. The mob table is read live each swing (alive = hp > 0).
    let hp = row.hp;
    let xp = row.xp;
    let level = row.level;
    let maxHp = row.maxHp;

    let s: PlayerState = stateFromRow(row);
    for (const byte of inputs) {
      const input = unpackInput(byte);
      // `attackFires` is evaluated on the PRE-step state, identically to the
      // client's prediction, so the swing decision is deterministic.
      const fires = attackFires(s, input);
      s = stepPlayer(s, input, MAPS);
      if (!fires) continue;

      // Only mobs on the player's CURRENT (post-step) map are hittable: a swing
      // can't reach across maps. A mob's map is derived from its spawn entry.
      const mobs = [...ctx.db.mob.iter()].filter((m) => MOB_SPAWNS[m.spawnIdx].map === s.mapId);
      const target = resolveAttackTarget(
        s,
        mobs.map((m) => ({ x: m.x, y: m.y, kind: m.kind as MobKind, alive: m.hp > 0 })),
      );
      if (target < 0) continue;

      const mob = mobs[target];
      const newHp = mob.hp - attackDamage(level);
      if (newHp > 0) {
        ctx.db.mob.id.update({ ...mob, hp: newHp, updatedAt: ctx.timestamp });
        continue;
      }
      // Kill: schedule the respawn and award XP, leveling up (full heal) while
      // the carried-over remainder still covers the next level's cost.
      ctx.db.mob.id.update({
        ...mob,
        hp: 0,
        respawnAt: plusMillis(ctx.timestamp, MOB_RESPAWN_MS),
        updatedAt: ctx.timestamp,
      });
      xp += MOB_STATS[mob.kind as MobKind].xp;
      while (xp >= xpToNext(level)) {
        xp -= xpToNext(level);
        level += 1;
        maxHp = maxHpForLevel(level);
        hp = maxHp;
      }
    }

    ctx.db.player.identity.update({
      ...row,
      x: s.x,
      y: s.y,
      vx: s.vx,
      vy: s.vy,
      facing: s.facing,
      onGround: s.onGround,
      rope: s.rope,
      hp,
      maxHp,
      xp,
      level,
      // Cooldown comes from the final replayed state so the next batch resumes
      // the same combat clock the client predicted.
      attackCooldown: s.attackCooldown,
      // mapId comes from the replay too: a portal step inside stepPlayer moved
      // the player to another map, persisted here with no separate reducer.
      mapId: s.mapId,
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
export const join = spacetimedb.reducer((ctx) => {
  const row = ctx.db.player.identity.find(ctx.sender);
  if (row) {
    // Reconnect under a persisted identity: keep where they left off (x, y,
    // name, facing) AND their progression (hp, xp, level), but re-arm the
    // speed-hack guard. Resetting tick to 0 with a fresh simStartAt is REQUIRED
    // — otherwise the wall-clock elapsed since the original spawn would let the
    // next batch burst far ahead of real time. attackCooldown resets to 0
    // alongside the other per-session sim fields.
    ctx.db.player.identity.update({
      ...row,
      vx: 0,
      vy: 0,
      onGround: false,
      rope: -1,
      attackCooldown: 0,
      online: true,
      tick: 0,
      simStartAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
    });
    return;
  }
  const name = 'Player-' + ctx.sender.toHexString().slice(0, 6);
  const maxHp = maxHpForLevel(1);
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
    hp: maxHp,
    maxHp,
    xp: 0,
    level: 1,
    attackCooldown: 0,
    invulnUntil: ctx.timestamp,
    mapId: 0, // new players start in town (map 0); rejoin keeps mapId via ...row.
    tick: 0,
    simStartAt: ctx.timestamp,
    updatedAt: ctx.timestamp,
  });
});

// Presence, not deletion: the row persists so the player resumes from their
// last position on the next join. Only the online flag flips.
export const onDisconnect = spacetimedb.clientDisconnected((ctx) => {
  const row = ctx.db.player.identity.find(ctx.sender);
  if (!row) return;
  ctx.db.player.identity.update({ ...row, online: false, updatedAt: ctx.timestamp });
});

// Player-chosen display name. Validation mirrors the client overlay's
// maxLength: a trimmed, control-character-free string of 1..16 chars.
export const setName = spacetimedb.reducer({ name: t.string() }, (ctx, { name }) => {
  const row = ctx.db.player.identity.find(ctx.sender);
  if (!row) return;
  const trimmed = validateText(name, MAX_NAME_LEN);
  if (trimmed === undefined) return;
  ctx.db.player.identity.update({ ...row, name: trimmed, updatedAt: ctx.timestamp });
});

// World chat. Only players who have joined (and are online) may speak. The text
// is validated like a name (trim, 1..120 chars, no control characters), then a
// per-sender rate limit is enforced WITHOUT touching the player schema: because
// the table is kept pruned to MESSAGE_KEEP rows, scanning it for the sender's
// most recent sentAt is cheap. The row stores a SNAPSHOT of the current name so
// later renames leave history intact. After inserting we prune oldest-first so
// both storage and the rate-limit scan stay bounded.
export const sendMessage = spacetimedb.reducer({ text: t.string() }, (ctx, { text }) => {
  const player = ctx.db.player.identity.find(ctx.sender);
  if (!player || !player.online) return;
  const trimmed = validateText(text, MAX_MESSAGE_LEN);
  if (trimmed === undefined) return;

  // Rate limit: reject if this sender posted within the last MESSAGE_MIN_GAP_MS.
  // The pruned table makes this full scan a fixed small cost.
  let lastSentAt: Timestamp | undefined;
  for (const m of ctx.db.message.iter()) {
    if (!m.sender.isEqual(ctx.sender)) continue;
    if (lastSentAt === undefined || m.sentAt.microsSinceUnixEpoch > lastSentAt.microsSinceUnixEpoch) {
      lastSentAt = m.sentAt;
    }
  }
  if (lastSentAt !== undefined && ctx.timestamp.since(lastSentAt).millis < MESSAGE_MIN_GAP_MS) {
    return;
  }

  ctx.db.message.insert({
    id: 0n, // autoInc
    sender: ctx.sender,
    name: player.name,
    text: trimmed,
    sentAt: ctx.timestamp,
  });

  // Prune oldest-first (autoInc id is monotonic, so the smallest id is oldest)
  // until at most MESSAGE_KEEP rows remain. Delete by the whole row to stay on
  // the table-level delete API the rest of the module uses.
  while (ctx.db.message.count() > BigInt(MESSAGE_KEEP)) {
    let oldest: MessageRow | undefined;
    for (const m of ctx.db.message.iter()) {
      if (oldest === undefined || m.id < oldest.id) oldest = m;
    }
    if (oldest === undefined) break;
    ctx.db.message.delete(oldest);
  }
});

/**
 * The mob-AI body, factored out and typed via the explicit `Ctx` so it keeps
 * full `ctx.db` typing. mobTick (the scheduled export) merely forwards to this;
 * see the mobTick declaration for why that indirection matters.
 */
function runMobTick(ctx: Ctx): void {
  // Defensive reseed: a republished DB whose init didn't reseed leaves an
  // empty mob table. Seed it (the timer row already exists, so don't re-add).
  if (ctx.db.mob.count() === 0n) {
    seedMobs(ctx);
    return;
  }

  const now = ctx.timestamp;
  for (const mob of ctx.db.mob.iter()) {
    const spawn = MOB_SPAWNS[mob.spawnIdx];
    if (mob.hp > 0) {
      // (a) Patrol: advance the alive mob's horizontal walk.
      const next = stepMobPatrol(mob.x, mob.dir, spawn, MOB_TICK_MS);
      ctx.db.mob.id.update({ ...mob, x: next.x, dir: next.dir, updatedAt: now });
    } else if (now.since(mob.respawnAt).millis >= 0) {
      // (b) Respawn a dead mob whose timer has elapsed, back at its home.
      ctx.db.mob.id.update({
        ...mob,
        x: spawn.x,
        dir: 1,
        hp: MOB_STATS[spawn.kind].maxHp,
        updatedAt: now,
      });
    }
  }

  // (c) Contact damage: any online player overlapping an alive mob (past their
  // invuln window) takes the mob's touch damage. hp <= 0 teleports them to
  // spawn at full HP. We do NOT touch `tick` — the client's next own-row ack
  // reconciles the teleport through the existing replay path.
  for (const player of ctx.db.player.iter()) {
    if (!player.online) continue;
    if (now.since(player.invulnUntil).millis < 0) continue;
    const pRect = {
      x: player.x - PLAYER_HALF_W,
      y: player.y - PLAYER_HALF_H,
      w: PLAYER_HALF_W * 2,
      h: PLAYER_HALF_H * 2,
    };
    let hit: MobKind | undefined;
    for (const mob of ctx.db.mob.iter()) {
      if (mob.hp <= 0) continue;
      // Only mobs on the player's CURRENT map can touch them: an off-map mob's
      // coordinates would otherwise spuriously overlap (maps share a coord space).
      if (MOB_SPAWNS[mob.spawnIdx].map !== player.mapId) continue;
      if (overlaps(mobBox(mob.x, mob.y, mob.kind as MobKind), pRect)) {
        hit = mob.kind as MobKind;
        break;
      }
    }
    if (!hit) continue;

    const hp = player.hp - MOB_STATS[hit].touchDamage;
    if (hp > 0) {
      ctx.db.player.identity.update({
        ...player,
        hp,
        invulnUntil: plusMillis(now, PLAYER_INVULN_MS),
        updatedAt: now,
      });
    } else {
      // Death: respawn at the start of map 0 (back to town, MapleStory-style),
      // fully healed. Movement state and mapId reset; tick is intentionally
      // untouched (the client's next ack reconciles the teleport + map switch
      // through the existing replay path). The mapId change drives the client to
      // swap maps via its own predicted-state watcher on the reconciled state.
      ctx.db.player.identity.update({
        ...player,
        x: SPAWN_X,
        y: SPAWN_Y,
        vx: 0,
        vy: 0,
        rope: -1,
        onGround: false,
        mapId: 0,
        hp: player.maxHp,
        invulnUntil: plusMillis(now, PLAYER_INVULN_MS),
        updatedAt: now,
      });
    }
  }
}

// Mob AI tick (10 Hz). The single param is the fired timer row; we never read it
// — the schedule itself is the clock. Private/scheduled, so clients can't call it.
//
// The explicit `ReducerExport<any, any>` annotation pairs with tables.ts's lazy
// mobTickRef to cut the tables.ts <-> reducers.ts cycle at BOTH the type and the
// runtime level: the typed body lives in runMobTick, and tables.ts never imports
// this value eagerly (it would TDZ-crash, since reducers.ts reads `spacetimedb`
// from tables.ts at its own top level). We hand the reducer to setMobTick so the
// scheduled thunk can resolve it at registration time.
export const mobTick: ReducerExport<any, any> = spacetimedb.reducer(
  { timer: t.row({ scheduledId: t.u64(), scheduledAt: t.scheduleAt() }) },
  (ctx) => {
    runMobTick(ctx);
  }
);
setMobTick(mobTick);
