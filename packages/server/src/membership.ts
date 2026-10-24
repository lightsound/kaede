// fallow-ignore-file coverage-gaps -- reducers only run inside a SpacetimeDB module host, so no unit test can import this file; the rules worth testing (admission, retention, rename validation, application and admin-action transitions) are delegated to evaluateJoin / isExpiredRow / evaluateRename / evaluateApplication / evaluateMemberAction in @kaede/shared and unit-tested there

// The membership reducers (承認制 / ゲスト入場設定): world entry with its
// admission check (join), renaming, the membership application, the four
// admin actions on one membership, and the guest-admission setting. Every
// status change here brings the world in line in the same transaction
// (syncPlayerToStatus, sweepGuestPlayers).
import {
  asMembership,
  evaluateApplication,
  evaluateJoin,
  evaluateMemberAction,
  evaluateRename,
  initialMembership,
  type MemberAction,
  type Membership,
} from '@kaede/shared';
import { SenderError, t } from 'spacetimedb/server';
import { persistMemberName } from './account';
import { spacetimedb } from './tables';
import {
  type Ctx,
  guestsAllowed,
  membershipOf,
  removePlayer,
  requireAdmin,
  type SenderIdentity,
  spawnOrResume,
  sweepExpiredRows,
  sweepOrphanedSiblings,
} from './world';

// Spawning is an explicit opt-in, not a connection side effect: observer
// connections (spacetime sql/subscribe, admin tooling) never call join, so
// they no longer flash into the world as phantom players.
//
// This is also where admission is enforced (承認制 / ゲスト入場設定): a
// pending member or an unadmitted guest gets a SenderError, not a spawn.
// Member-versus-guest is decided by the space_member row's existence —
// only classified members ever get one (clientConnected), and senderAuth
// is not readable outside clientConnected. Clients rule on the same
// subscribed rows via decideAdmission and normally never send a join that
// would be refused; this check is the authority they cannot bypass.
export const join = spacetimedb.reducer((ctx) => {
  const admission = evaluateJoin({
    membership: membershipOf(ctx, ctx.sender),
    guestsAllowed: guestsAllowed(ctx),
  });
  if (!admission.ok) {
    throw new SenderError(`Join refused (${admission.reason})`);
  }
  sweepExpiredRows(ctx);
  sweepOrphanedSiblings(ctx);
  spawnOrResume(ctx);
});

// Renames the sender everywhere it is visible right now (its player_name
// row — the label every client renders) and, for members, persists the name
// on the account so every future join — any device, any reconnect — spawns
// under it. Guests have no account, so their rename lives only as long as
// their per-tab identity's player rows.
// Admission (name validation, refusing a rename with nowhere to land) is the
// pure evaluateRename, unit-tested in @kaede/shared — the same rules the
// client checks against before sending.
// Deliberately does NOT touch player.updatedAt (the pre-split rename did,
// incidentally, by rewriting the whole row): renaming is not liveness.
// Liveness is proven by input batches while moving and by heartbeats
// (empty submit_inputs) while the send gate keeps a quiescent client
// silent — see submitInputs. A client that stops sending even those is
// gone (or cut by its own idle guard), after which sweeping its row is
// exactly right. Bumping the hot row here would also re-broadcast a
// position update to every client for a change the player_name event
// already carries.
export const setDisplayName = spacetimedb.reducer({ name: t.string() }, (ctx, { name }) => {
  const hasAccount = ctx.db.account.identity.find(ctx.sender) !== null;
  const row = ctx.db.playerName.identity.find(ctx.sender);
  const verdict = evaluateRename({
    rawName: name,
    hasAccount,
    hasNameRow: row !== null,
  });
  if (!verdict.ok) {
    throw new SenderError(`Rename refused (${verdict.reason})`);
  }
  persistMemberName(ctx, verdict.name);
  if (row !== null) {
    ctx.db.playerName.identity.update({ ...row, name: verdict.name });
  }
});

/** Writes the sender's application: a fresh row, or the rejected row re-filed. */
function fileApplication(ctx: Ctx, accountName: string | undefined): Membership {
  const existing = ctx.db.spaceMember.identity.find(ctx.sender);
  if (existing !== null) {
    // Re-application after a rejection: reuse the row, refresh requestedAt
    // so the pending list sorts by the latest ask.
    const updated = ctx.db.spaceMember.identity.update({
      ...existing,
      status: 'pending',
      requestedAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
    });
    return asMembership(updated);
  }
  const inserted = ctx.db.spaceMember.insert({
    identity: ctx.sender,
    // The public projection of the account's persisted name.
    displayName: accountName,
    ...initialMembership(ctx.db.spaceMember.count() === 0n),
    requestedAt: ctx.timestamp,
    updatedAt: ctx.timestamp,
  });
  return asMembership(inserted);
}

// Files (or re-files) the sender's membership application (承認制の申請側).
// An explicit act, never a connection side effect: a rejected applicant
// returns to the pending list only by choosing to, so a rejection cannot
// bounce straight back in front of the admin. The very first application
// seeds the admin (see initialMembership).
export const applyForMembership = spacetimedb.reducer((ctx) => {
  const account = ctx.db.account.identity.find(ctx.sender);
  const verdict = evaluateApplication({
    hasAccount: account !== null,
    membership: membershipOf(ctx, ctx.sender),
  });
  if (!verdict.ok) {
    throw new SenderError(`apply_for_membership refused (${verdict.reason})`);
  }
  const filed = fileApplication(ctx, account === null ? undefined : account.displayName);
  // The first application is seeded approved (the admin stays in the
  // world); everyone else's lands pending, which moves them from the world
  // — where they may have been walking around under the guest rules — to
  // the waiting room.
  syncPlayerToStatus(ctx, ctx.sender, filed.status);
});

/**
 * Enforces "only approved memberships may be in the world" right where a
 * status changes: whoever just became non-approved loses their player row
 * in the same transaction, so join's refusal of their status and their
 * presence in the world can never contradict each other.
 */
function syncPlayerToStatus(
  ctx: Ctx,
  identity: SenderIdentity,
  status: Membership['status'],
): void {
  if (status !== 'approved') {
    removePlayer(ctx, identity);
  }
}

/**
 * The shared body of the four admin actions on one membership (approve /
 * reject / ban / unban — 承認制の管理側). Every action is a status
 * transition on the existing row, vetted by the pure evaluateMemberAction
 * (unit-tested in @kaede/shared); the account is never touched, so no
 * space-level action can damage the target's global profile, and any
 * mistake is reversible by another action. The admin check is server-side
 * and final — the client-side gating of the admin panel is cosmetic.
 *
 * A transition landing on a non-approved status also removes the target's
 * avatar (syncPlayerToStatus): their client sees the membership flip and
 * shows the refusal instead of auto-rejoining.
 */
function transitionMember(ctx: Ctx, identity: SenderIdentity, action: MemberAction): void {
  const target = ctx.db.spaceMember.identity.find(identity);
  const verdict = evaluateMemberAction({
    actor: membershipOf(ctx, ctx.sender),
    target: target === null ? undefined : asMembership(target),
    action,
  });
  if (!verdict.ok) {
    throw new SenderError(`${action}_member refused (${verdict.reason})`);
  }
  if (target === null) {
    // Unreachable — evaluateMemberAction refuses a missing target as
    // no-such-member — but narrowing must not read as a silent no-op.
    throw new SenderError(`${action}_member refused (no-such-member)`);
  }
  ctx.db.spaceMember.identity.update({
    ...target,
    status: verdict.nextStatus,
    updatedAt: ctx.timestamp,
  });
  syncPlayerToStatus(ctx, identity, verdict.nextStatus);
}

/** One admin action as a callable reducer; the export name names the reducer. */
function memberActionReducer(action: MemberAction) {
  return spacetimedb.reducer({ identity: t.identity() }, (ctx, { identity }) =>
    transitionMember(ctx, identity, action),
  );
}

// The four admin actions (what each does and when it is allowed:
// MemberAction and evaluateMemberAction in @kaede/shared). An approved
// member's waiting client sees its space_member row update and joins on its
// own; the other three also remove the target's avatar (transitionMember).
export const approveMember = memberActionReducer('approve');
export const rejectMember = memberActionReducer('reject');
export const banMember = memberActionReducer('ban');
export const unbanMember = memberActionReducer('unban');

/** Writes the guest-admission flag to the settings singleton (id 0). */
function upsertGuestsAllowed(ctx: Ctx, allowed: boolean): void {
  const existing = ctx.db.spaceSetting.id.find(0);
  if (existing) {
    ctx.db.spaceSetting.id.update({ ...existing, guestsAllowed: allowed });
    return;
  }
  ctx.db.spaceSetting.insert({ id: 0, guestsAllowed: allowed });
}

/**
 * Deletes every player row that has no membership behind it — i.e. the
 * guests. Identities are collected first so nothing is removed out from
 * under the iterator (the sweepExpiredRows precedent).
 */
function sweepGuestPlayers(ctx: Ctx): void {
  const guests = [];
  for (const row of ctx.db.player.iter()) {
    if (ctx.db.spaceMember.identity.find(row.identity) === null) {
      guests.push(row.identity);
    }
  }
  for (const identity of guests) removePlayer(ctx, identity);
}

// Toggles guest admission (ゲスト入場の許可/不許可 — the single-space
// prototype of the future per-organization setting). Turning guests off
// kicks the guests already in the world in the same transaction, rather
// than letting them linger until their next join: the setting exists so an
// admin can say "no guests in the room right now" (e.g. before a sensitive
// conversation), and in an always-connected office "from the next entry"
// may as well mean never. The kicked clients see the setting row flip and
// show the refusal notice instead of auto-rejoining.
export const setGuestsAllowed = spacetimedb.reducer({ allowed: t.bool() }, (ctx, { allowed }) => {
  requireAdmin(ctx, 'set_guests_allowed');
  upsertGuestsAllowed(ctx, allowed);
  if (!allowed) sweepGuestPlayers(ctx);
});
