// fallow-ignore-file coverage-gaps -- helpers over the SpacetimeDB reducer context; they only run inside a module host, and the rules worth testing (admission, retention, name precedence) are delegated to evaluateJoin / isExpiredRow / resolveJoinName in @kaede/shared and unit-tested there

// Who is in the world, and how their rows enter and leave it — the player
// lifecycle plus the admission reads it depends on. Its own module (not
// reducers.ts) because every reducer file builds on it: reducers.ts for
// join/movement/membership, posting.ts for chat and reactions. Nothing here
// is a spacetime export, which is also why it must not be re-exported from
// index.ts (the host refuses non-reducer entry exports).
import {
  asMembership,
  chatOverflowIds,
  DEFAULT_MAP_ID,
  evaluateJoin,
  GROUP_KIND_HUDDLE,
  guestsAllowedFrom,
  isExpiredRow,
  keepsHuddleMembership,
  type Membership,
  resolveJoinName,
  resolveZoneOccupancy,
  type SendAllowanceRequest,
  type SendAllowanceVerdict,
  SPAWN_X,
  SPAWN_Y,
  sortedZoneRows,
  type ZoneShape,
} from '@kaede/shared';
import type { InferSchema, ReducerCtx } from 'spacetimedb/server';
import { SenderError } from 'spacetimedb/server';
import type { spacetimedb } from './tables';

/** The reducer context for this module's schema, for helpers that touch the db. */
export type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;

/** The Identity type as this schema's rows carry it (not re-exported by the server SDK). */
export type SenderIdentity = Ctx['sender'];

/** The sender-facing standing of an identity: its membership, or undefined for guests. */
export function membershipOf(ctx: Ctx, identity: SenderIdentity): Membership | undefined {
  const row = ctx.db.spaceMember.identity.find(identity);
  return row === null ? undefined : asMembership(row);
}

/** The guest-admission setting, read with the shared missing-row default. */
export function guestsAllowed(ctx: Ctx): boolean {
  return guestsAllowedFrom(ctx.db.spaceSetting.id.find(0));
}

/** An append-log table as the retention trim needs it (id = insert order). */
export interface HistoryTable {
  iter(): Iterable<{ id: bigint }>;
  id: { delete(id: bigint): unknown };
}

/**
 * Deletes the oldest rows beyond the retention cap (保持方針 — see the
 * chat_message table comment for why row count is the budget that matters,
 * and DM_HISTORY_MAX for what the dm_message cap bounds instead). Runs
 * after every insert, so a table can only ever exceed its cap by the one
 * row just inserted and the enumeration stays cheap. One function for every
 * append log — chat, DMs (posting.ts) and the connection-event log
 * (reducers.ts): the same rule, deliberately not cloned. Lives here rather
 * than posting.ts because index.ts `export *`s the reducer files and the
 * host refuses non-spacetime entry exports (this file's header rule).
 */
export function trimHistory(table: HistoryTable, max: number): void {
  const ids = [...table.iter()].map((row) => row.id);
  for (const id of chatOverflowIds(ids, max)) {
    table.id.delete(id);
  }
}

// ── Player lifecycle ────────────────────────────────────────────────────
// The three player_* tables (hot row, name label, guard — see tables.ts)
// are kept paired by construction, and this section is all of it on one
// screen: spawnOrResume (with upsertPlayerSiblings) is the only create
// path, removePlayer the only delete path, and findWorldRows /
// sweepOrphanedSiblings reclaim a broken pair from either direction
// instead of acting on it.

/**
 * Removes one player from the world: the hot row and its name/guard
 * siblings, in the same transaction. The single delete path — every
 * reclaim (sweep, guest kick, status change, stale-row and broken-pair
 * reclaim) goes through here, which is what keeps the three player_*
 * tables paired (a player row always has its siblings). The chat_guard,
 * reaction, player_status and their guard rows ride along even though they
 * are not siblings (created lazily by send_chat_message / send_reaction /
 * the status reducers, so a player row need not have them): their owner
 * may chat, react and set a status only while in the world, so leaving
 * the world is when they stop meaning anything — and deleting them here
 * is what keeps per-tab guest identities from piling up rows forever (for
 * the public `reaction` and `player_status` tables, rows that would ride
 * every entering client's egress).
 */
export function removePlayer(ctx: Ctx, identity: SenderIdentity): void {
  // Read before the deletes: leaving the world is also leaving one's
  // conversation group, and a huddle whose last member leaves must be
  // cleaned up (cleanupEmptyHuddle) — which needs the groupId the
  // membership row is about to stop naming.
  const membership = ctx.db.groupMember.identity.find(identity);
  const identityKeyed: { identity: { delete(identity: SenderIdentity): unknown } }[] = [
    ctx.db.player,
    ctx.db.playerName,
    ctx.db.playerGuard,
    ctx.db.chatGuard,
    ctx.db.reaction,
    ctx.db.reactionGuard,
    ctx.db.playerStatus,
    ctx.db.statusGuard,
    ctx.db.portalGuard,
    ctx.db.huddleGuard,
    ctx.db.groupMember,
  ];
  for (const table of identityKeyed) table.identity.delete(identity);
  if (membership !== null) cleanupEmptyHuddle(ctx, membership.groupId);
}

/** A row as this schema's tables return it (not re-exported by the server SDK). */
export type RowIn<T extends 'player' | 'playerName' | 'playerGuard'> = NonNullable<
  ReturnType<Ctx['db'][T]['identity']['find']>
>;

/** The player_name row as this schema returns it (not re-exported by the server SDK). */
type PlayerNameRow = RowIn<'playerName'>;

/**
 * Upserts the sender's player_* sibling rows for a join: the display name to
 * spawn under, and a fresh input allowance on the guard. One function for
 * both because they are only ever written together (spawnOrResume), which is
 * half of what keeps the siblings paired with the player row — removePlayer
 * is the other half. `nameRow` is the caller's own lookup (it already read
 * the row to resolve the join name), passed in rather than re-found.
 */
function upsertPlayerSiblings(ctx: Ctx, nameRow: PlayerNameRow | null, name: string): void {
  // `online: true` because a join IS liveness — the resumed row's stale
  // offline flag must not linger on the presence directory.
  if (nameRow) ctx.db.playerName.identity.update({ ...nameRow, name, online: true });
  else ctx.db.playerName.insert({ identity: ctx.sender, name, online: true });

  const allowanceMicros = ctx.timestamp.microsSinceUnixEpoch;
  const guard = ctx.db.playerGuard.identity.find(ctx.sender);
  if (guard) ctx.db.playerGuard.identity.update({ ...guard, allowanceMicros });
  else ctx.db.playerGuard.insert({ identity: ctx.sender, allowanceMicros });
}

/** Resumes the sender's surviving player row, or spawns a fresh one. */
export function spawnOrResume(ctx: Ctx): void {
  const existing = ctx.db.player.identity.find(ctx.sender);
  const nameRow = ctx.db.playerName.identity.find(ctx.sender);
  // Precedence (persisted account name > resumed row's name > default) lives
  // in resolveJoinName, unit-tested in @kaede/shared.
  const name = resolveJoinName({
    persistedName: ctx.db.account.identity.find(ctx.sender)?.displayName,
    resumedRowName: nameRow?.name,
    identityHex: ctx.sender.toHexString(),
  });
  upsertPlayerSiblings(ctx, nameRow, name);

  if (existing) {
    // Reload / network blip within the retention window: resume the saved
    // character where it stood (the sibling upsert above already refreshed
    // the name and input allowance). The occupancy re-check covers zones
    // edited while the row sat offline.
    ctx.db.player.identity.update({
      ...existing,
      online: true,
      updatedAt: ctx.timestamp,
    });
    syncGroupOccupancy(ctx, ctx.sender, { x: existing.x, y: existing.y }, existing.mapId);
    return;
  }

  ctx.db.player.insert({
    identity: ctx.sender,
    x: SPAWN_X,
    y: SPAWN_Y,
    vx: 0,
    vy: 0,
    facing: 1,
    onGround: false,
    rope: -1,
    tick: 0,
    online: true,
    updatedAt: ctx.timestamp,
    mapId: DEFAULT_MAP_ID, // fresh spawns start on the default map; resumes keep theirs
  });
  syncGroupOccupancy(ctx, ctx.sender, { x: SPAWN_X, y: SPAWN_Y }, DEFAULT_MAP_ID);
}

/**
 * Mirrors player.online onto the public player_name row — the space-wide
 * presence directory the map-scoped player subscription cannot serve (see
 * the player_name table comment). Written only when the flag actually
 * flips, so the mirror costs nothing on the hot paths that assert
 * `online: true` on every accepted batch.
 */
export function syncNameOnline(ctx: Ctx, nameRow: RowIn<'playerName'>, online: boolean): void {
  if (nameRow.online === online) return;
  ctx.db.playerName.identity.update({ ...nameRow, online });
}

/** The rows the in-world reducers act on. */
export interface WorldRows {
  row: RowIn<'player'>;
  guard: RowIn<'playerGuard'>;
  nameRow: RowIn<'playerName'>;
}

/**
 * Why the sender has no world rows to act on. The two reasons encode the
 * loud/silent refusal rule (see sendChatMessage in posting.ts): after
 * `not-in-world` nothing was written, so a caller may throw a SenderError;
 * after `reclaimed` this module just deleted the sender's rows and a throw
 * would roll that reclaim back — reducers are atomic — so callers must
 * RETURN. The discriminant makes that rule a checked value instead of
 * prose the caller re-derives with its own row lookup.
 */
export type WorldRowsVerdict =
  | { ok: true; rows: WorldRows }
  | { ok: false; reason: 'not-in-world' | 'reclaimed' };

/**
 * The sender's hot row and its name/guard siblings — split out of the
 * reducers that act on the in-world sender (submitInputs, the posting
 * reducers) to keep those uncovered arrows under the CRAP budget fallow
 * enforces (the backfillAccountName precedent). A row missing either
 * sibling cannot happen through this module's write paths (the lifecycle
 * functions above), but if one ever appears (manual sql, a future bug) it
 * is reclaimed rather than tolerated — the transitionMember precedent that
 * an "unreachable" branch must not read as a silent no-op. A missing guard
 * would otherwise silence the sender's inputs forever with nothing to
 * repair it; a missing name would otherwise persist too, since only this
 * check sees the resume path (a client resuming its surviving row never
 * calls join, so the sibling upsert there cannot heal it) and
 * set_display_name refuses rather than adopts a nameless player. The owner
 * sees its row deleted and re-joins, recreating all three siblings.
 */
function findWorldRows(ctx: Ctx): WorldRowsVerdict {
  const row = ctx.db.player.identity.find(ctx.sender);
  if (!row) return { ok: false, reason: 'not-in-world' };
  const guard = ctx.db.playerGuard.identity.find(ctx.sender);
  const nameRow = ctx.db.playerName.identity.find(ctx.sender);
  if (guard && nameRow) return { ok: true, rows: { row, guard, nameRow } };
  console.warn(`player row missing a sibling, reclaiming: sender=${ctx.sender.toHexString()}`);
  removePlayer(ctx, ctx.sender);
  return { ok: false, reason: 'reclaimed' };
}

/**
 * The sender's world rows if the admission rules would still admit it —
 * the shared preamble of every reducer that acts as "someone in the world"
 * (submitInputs, and the posting reducers through posting.ts's
 * findPostingSender). Admission applies to acting, not just to joining: a
 * player row whose owner the rules would now refuse (possible only as a
 * leftover from before the rules — e.g. a re-publish onto a database with
 * pre-admission rows, since every status change deletes the row
 * transactionally) must not keep driving movement or speaking, so it is
 * reclaimed rather than obeyed. What a refusal permits the caller to do is
 * carried by the verdict's reason — see WorldRowsVerdict.
 */
export function findAdmittedWorldRows(ctx: Ctx): WorldRowsVerdict {
  const found = findWorldRows(ctx);
  if (!found.ok) return found;
  const admission = evaluateJoin({
    membership: membershipOf(ctx, ctx.sender),
    guestsAllowed: guestsAllowed(ctx),
  });
  if (admission.ok) return found;
  removePlayer(ctx, ctx.sender);
  return { ok: false, reason: 'reclaimed' };
}

/**
 * The shared preamble of every reducer that posts or acts as "someone in
 * the world" and wants the sender's rows (the chat/DM/huddle reducers):
 * the world rows, or undefined after a refusal. The two refusal reasons
 * split along the loud/silent rule documented on sendChatMessage
 * (posting.ts), and the verdict's contract (WorldRowsVerdict) is what
 * makes each branch safe: `not-in-world` wrote nothing, so it may throw;
 * `reclaimed` just deleted the sender's rows and must commit, so it stays
 * a logged return. Lives here rather than in a reducer file because both
 * posting.ts and huddles.ts need it, index.ts `export *`s those, and the
 * host refuses non-spacetime entry exports (this file's header rule) —
 * the chargeSendAllowance precedent.
 */
export function findPostingSender(ctx: Ctx, reducerName: string): WorldRows | undefined {
  const found = findAdmittedWorldRows(ctx);
  if (found.ok) return found.rows;
  if (found.reason === 'not-in-world') {
    throw new SenderError(`${reducerName} refused (not-in-world)`);
  }
  console.warn(`${reducerName} dropped (reclaimed): sender=${ctx.sender.toHexString()}`);
  return undefined;
}

/**
 * Identities holding a name, guard, reaction, status or group-membership
 * row whose player row is gone. The public tables (player_name, reaction,
 * player_status, group_member) are enumerated because an orphaned row in
 * any of them would ride every entering client's egress — and an orphaned
 * group_member row additionally holds a conversation-group seat (増分④
 * reads chat visibility off it); the private lazy guards (chat_guard,
 * reaction_guard, status_guard) merely sit as junk — removePlayer deletes
 * those too once an orphan is found by any table here.
 */
function orphanedSiblingIdentities(ctx: Ctx): SenderIdentity[] {
  const orphans = [];
  for (const row of [
    ...ctx.db.playerName.iter(),
    ...ctx.db.playerGuard.iter(),
    ...ctx.db.reaction.iter(),
    ...ctx.db.playerStatus.iter(),
    ...ctx.db.groupMember.iter(),
  ]) {
    if (ctx.db.player.identity.find(row.identity) === null) orphans.push(row.identity);
  }
  return orphans;
}

/**
 * Reclaims sibling rows whose player row was deleted out from under them —
 * the mirror image of findWorldRows' broken-pair reclaim, needed because
 * both expiry sweeps iterate only `player`: an orphaned sibling has no
 * `updatedAt` to expire and would sit forever, with the player_name half in
 * a public table every client downloads on its initial subscription. As
 * unreachable through this module's write paths as the other direction, and
 * as real: this project does operate the database through raw SQL (the
 * guest-admission spec drives its setting flips through the CLI's `sql`),
 * where `DELETE FROM player` alone is the intuitive kick. An identity may
 * appear twice (both siblings orphaned); the second removePlayer is a
 * no-op — row deletes tolerate missing rows, the tolerance removePlayer
 * already relies on.
 */
export function sweepOrphanedSiblings(ctx: Ctx): void {
  for (const identity of orphanedSiblingIdentities(ctx)) removePlayer(ctx, identity);
}

/**
 * Deletes rows whose retention window has elapsed, whatever they are flagged
 * as: see isExpiredRow for why age rather than `online` decides. Identities are
 * collected first so nothing is removed out from under the iterator.
 *
 * A client throttled long enough to be swept while still connected notices the
 * delete of its own row and re-joins, so reclaiming a row is recoverable.
 */
export function sweepExpiredRows(ctx: Ctx): void {
  const stale = [];
  for (const row of ctx.db.player.iter()) {
    if (isExpiredRow(ctx.timestamp.since(row.updatedAt).millis)) {
      stale.push(row.identity);
    }
  }
  for (const identity of stale) removePlayer(ctx, identity);
}
// ── End player lifecycle ────────────────────────────────────────────────

// ── Group occupancy (ROADMAP Phase 3 増分②③) ────────────────────────────
// Who is in which conversation group, judged server-side wherever the
// authoritative position or the zone set changes: accepted input batches
// and portal landings (reducers.ts), joins (spawnOrResume above), and the
// admin zone edits (zones.ts, through recomputeZoneOccupancyOnMap). The
// rules themselves — zone hysteresis and overlap priority
// (resolveZoneOccupancy), the huddle walk-away rule
// (keepsHuddleMembership) — are unit-tested in @kaede/shared; see zone.ts
// there for why this is deliberately NOT the portal pattern of
// client-detected reducer calls.

/**
 * The zone-kind groups placed on `mapId` in id order (sortedZoneRows —
 * the deterministic overlap priority), shaped for the occupancy rule.
 */
function zonesOnMap(ctx: Ctx, mapId: number): ZoneShape[] {
  return sortedZoneRows(ctx.db.conversationGroup.iter())
    .filter((row) => row.mapId === mapId)
    .map((row) => ({ id: row.id, rect: { x: row.x, y: row.y, w: row.w, h: row.h } }));
}

/** The conversation_group row `groupId` names IF it is a huddle, else null. */
function huddleRowOf(ctx: Ctx, groupId: bigint) {
  const row = ctx.db.conversationGroup.id.find(groupId);
  return row !== null && row.kind === GROUP_KIND_HUDDLE ? row : null;
}

/**
 * The identities holding a membership in `groupId`, minus `except`.
 * Iterates the whole membership table (bounded by the world population;
 * the groupId btree index is for 増分④'s RLS, and the generated API
 * exposes no filtered scan). Split from the position lookup below to keep
 * both uncovered functions under the CRAP budget fallow enforces.
 */
function huddleMemberIdentities(ctx: Ctx, groupId: bigint, except: SenderIdentity) {
  const identities = [];
  for (const member of ctx.db.groupMember.iter()) {
    if (member.groupId === groupId && !member.identity.isEqual(except)) {
      identities.push(member.identity);
    }
  }
  return identities;
}

/**
 * The authoritative AABB centers of `groupId`'s members other than
 * `except` — what the huddle join and retention rules measure distance
 * against. Members always have player rows (removePlayer deletes the
 * membership alongside), so the null check is the usual tolerance, not a
 * reachable state.
 */
export function otherHuddleMemberPositions(
  ctx: Ctx,
  groupId: bigint,
  except: SenderIdentity,
): { x: number; y: number }[] {
  const positions = [];
  for (const identity of huddleMemberIdentities(ctx, groupId, except)) {
    const row = ctx.db.player.identity.find(identity);
    if (row !== null) positions.push({ x: row.x, y: row.y });
  }
  return positions;
}

/**
 * Deletes a huddle row once nothing references it — the 「0人になったら
 * 行を掃除」 rule, called by every membership-removal path (the huddle
 * reducers' leave/switch, the occupancy pass's auto-leave, removePlayer).
 * Zone rows never qualify (kind-checked): a zone is placed config that
 * exists independently of its occupants.
 */
export function cleanupEmptyHuddle(ctx: Ctx, groupId: bigint): void {
  if (huddleRowOf(ctx, groupId) === null) return;
  for (const member of ctx.db.groupMember.iter()) {
    if (member.groupId === groupId) return;
  }
  ctx.db.conversationGroup.id.delete(groupId);
}

/**
 * Re-rules one player's group_member row after a movement of the
 * authoritative position. Two regimes, by what the row currently names:
 * - A HUDDLE: only the walk-away rule applies (keepsHuddleMembership).
 *   While the membership holds, zone geometry never reassigns it —
 *   joining a huddle was an explicit act, and standing inside a meeting
 *   room while in one must not silently swap the conversation (the
 *   design decision recorded on group_member in tables.ts). Once the
 *   member walks (or teleports) away, the membership drops and the zone
 *   ruling below runs in the same pass — they may be standing in a zone.
 * - A ZONE or nothing: the 増分② geometry rule (hysteresis, overlap
 *   priority), writes only on actual transitions.
 * `position` is the authoritative AABB center AFTER the movement.
 */
export function syncGroupOccupancy(
  ctx: Ctx,
  identity: SenderIdentity,
  position: { x: number; y: number },
  mapId: number,
): void {
  const member = ctx.db.groupMember.identity.find(identity);
  if (member !== null) {
    const huddle = huddleRowOf(ctx, member.groupId);
    if (huddle !== null) {
      const keeps = keepsHuddleMembership({
        position,
        mapId,
        huddleMapId: huddle.mapId,
        otherMemberPositions: otherHuddleMemberPositions(ctx, huddle.id, identity),
      });
      if (keeps) return;
      ctx.db.groupMember.identity.delete(identity);
      cleanupEmptyHuddle(ctx, huddle.id);
      syncZoneOccupancy(ctx, identity, position, mapId, null);
      return;
    }
  }
  syncZoneOccupancy(ctx, identity, position, mapId, member);
}

/** A group_member row as this schema returns it. */
type GroupMemberRow = NonNullable<ReturnType<Ctx['db']['groupMember']['identity']['find']>>;

/**
 * The zone half of the occupancy pass (増分②): re-rules `member` (the
 * caller's own lookup, or null after a huddle auto-leave just deleted it)
 * against the zones on the map and writes only actual transitions — a
 * no-transition pass writes nothing, so the common case (moving around
 * inside or outside a zone) costs reads only.
 */
function syncZoneOccupancy(
  ctx: Ctx,
  identity: SenderIdentity,
  position: { x: number; y: number },
  mapId: number,
  member: GroupMemberRow | null,
): void {
  const next = resolveZoneOccupancy({
    position,
    zones: zonesOnMap(ctx, mapId),
    currentZoneId: member?.groupId,
  });
  if (member === null) {
    if (next !== undefined) ctx.db.groupMember.insert({ identity, groupId: next });
    return;
  }
  moveZoneMembership(ctx, identity, member, next);
}

/**
 * Writes an existing membership's transition: leave (delete) or switch
 * (update); a same-zone verdict writes nothing — an unchanged upsert would
 * still broadcast to every subscriber. Split from syncZoneOccupancy to
 * keep these uncovered functions under the CRAP budget fallow enforces
 * (the backfillAccountName precedent).
 */
function moveZoneMembership(
  ctx: Ctx,
  identity: SenderIdentity,
  member: GroupMemberRow,
  next: bigint | undefined,
): void {
  if (next === undefined) {
    ctx.db.groupMember.identity.delete(identity);
    return;
  }
  if (next !== member.groupId) {
    ctx.db.groupMember.identity.update({ ...member, groupId: next });
  }
}

/**
 * Re-rules every player on `mapId` — the zone-edit counterpart of the
 * per-movement pass, because a zone appearing, resizing, moving or
 * vanishing changes occupancy for players who are standing still (and a
 * quiescent player sends nothing the movement pass could rule on).
 * Offline-but-retained rows are included on purpose: their occupancy must
 * track the zone set so a resume within the retention window comes back
 * consistent. Huddle members pass through unchanged (the
 * syncGroupOccupancy stickiness — a zone edit is no reason to leave a
 * conversation, and nobody moved). O(players × zones) on one map, on a
 * rare admin action.
 */
export function recomputeZoneOccupancyOnMap(ctx: Ctx, mapId: number): void {
  for (const row of ctx.db.player.iter()) {
    if (row.mapId === mapId) {
      syncGroupOccupancy(ctx, row.identity, { x: row.x, y: row.y }, mapId);
    }
  }
}
// ── End group occupancy ─────────────────────────────────────────────────

/** A send-rate token-bucket marker table (identity → allowanceMicros). */
export type SendGuardTable =
  | Ctx['db']['chatGuard']
  | Ctx['db']['reactionGuard']
  | Ctx['db']['statusGuard']
  | Ctx['db']['portalGuard'];

/** A send-rate guard row, as any marker table returns it. */
type SendGuardRow = NonNullable<ReturnType<SendGuardTable['identity']['find']>>;

/**
 * Charges one send against the sender's token bucket on `guardTable`, or
 * refuses the send (乱用対策 — the Phase 0 input guard's thinking applied
 * to chat, reactions, statuses and portal use). The rule itself is the pure
 * `evaluate` (evaluateChatSend and friends, unit-tested in @kaede/shared);
 * a missing guard row reads as the epoch marker, which the bucket's bank
 * cap turns into exactly one full burst. Lives here rather than posting.ts
 * (its original home) because the guarded reducers now span both reducer
 * files, and index.ts `export *`s those, while the host refuses
 * non-spacetime entry exports (this file's header rule). The marker
 * write-back is split into writeSendAllowance to keep these uncovered
 * arrows under the CRAP budget fallow enforces.
 */
export function chargeSendAllowance(
  ctx: Ctx,
  guardTable: SendGuardTable,
  evaluate: (request: SendAllowanceRequest) => SendAllowanceVerdict,
  reducerName: string,
): void {
  const guard = guardTable.identity.find(ctx.sender);
  const verdict = evaluate({
    allowanceMicros: guard?.allowanceMicros ?? 0n,
    nowMicros: ctx.timestamp.microsSinceUnixEpoch,
  });
  if (!verdict.ok) throw new SenderError(`${reducerName} refused (rate-limited)`);
  writeSendAllowance(ctx, guardTable, guard, verdict.allowanceMicros);
}

/** Writes the advanced marker back: the sender's row, or its lazy first one. */
function writeSendAllowance(
  ctx: Ctx,
  guardTable: SendGuardTable,
  existing: SendGuardRow | null,
  allowanceMicros: bigint,
): void {
  if (existing) {
    guardTable.identity.update({ ...existing, allowanceMicros });
    return;
  }
  guardTable.insert({ identity: ctx.sender, allowanceMicros });
}
