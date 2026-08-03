// fallow-ignore-file coverage-gaps -- helpers over the SpacetimeDB reducer context; they only run inside a module host, and the rules worth testing (admission, retention, name precedence) are delegated to evaluateJoin / isExpiredRow / resolveJoinName in @maple/shared and unit-tested there

// Who is in the world, and how their rows enter and leave it — the player
// lifecycle plus the admission reads it depends on. Its own module (not
// reducers.ts) because every reducer file builds on it: reducers.ts for
// join/movement/membership, posting.ts for chat and reactions. Nothing here
// is a spacetime export, which is also why it must not be re-exported from
// index.ts (the host refuses non-reducer entry exports).
import {
  asMembership,
  evaluateJoin,
  guestsAllowedFrom,
  isExpiredRow,
  type Membership,
  resolveJoinName,
  SPAWN_X,
  SPAWN_Y,
} from '@maple/shared';
import type { InferSchema, ReducerCtx } from 'spacetimedb/server';
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
  ctx.db.player.identity.delete(identity);
  ctx.db.playerName.identity.delete(identity);
  ctx.db.playerGuard.identity.delete(identity);
  ctx.db.chatGuard.identity.delete(identity);
  ctx.db.reaction.identity.delete(identity);
  ctx.db.reactionGuard.identity.delete(identity);
  ctx.db.playerStatus.identity.delete(identity);
  ctx.db.statusGuard.identity.delete(identity);
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
  if (nameRow) ctx.db.playerName.identity.update({ ...nameRow, name });
  else ctx.db.playerName.insert({ identity: ctx.sender, name });

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
  // in resolveJoinName, unit-tested in @maple/shared.
  const name = resolveJoinName({
    persistedName: ctx.db.account.identity.find(ctx.sender)?.displayName,
    resumedRowName: nameRow?.name,
    identityHex: ctx.sender.toHexString(),
  });
  upsertPlayerSiblings(ctx, nameRow, name);

  if (existing) {
    // Reload / network blip within the retention window: resume the saved
    // character where it stood (the sibling upsert above already refreshed
    // the name and input allowance).
    ctx.db.player.identity.update({
      ...existing,
      online: true,
      updatedAt: ctx.timestamp,
    });
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
  });
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
 * Identities holding a name, guard, reaction or status row whose player row
 * is gone. `reaction` and `player_status` are enumerated alongside the join
 * siblings because they are public: an orphaned row in either would ride
 * every entering client's egress, where the private lazy guards
 * (chat_guard, reaction_guard, status_guard) merely sit as junk —
 * removePlayer deletes those too once an orphan is found by any table here.
 */
function orphanedSiblingIdentities(ctx: Ctx): SenderIdentity[] {
  const orphans = [];
  for (const row of [
    ...ctx.db.playerName.iter(),
    ...ctx.db.playerGuard.iter(),
    ...ctx.db.reaction.iter(),
    ...ctx.db.playerStatus.iter(),
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
