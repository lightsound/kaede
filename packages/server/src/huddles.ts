// fallow-ignore-file coverage-gaps -- reducers only run inside a SpacetimeDB module host, so no unit test can import this file; the rules worth testing (name normalization, join geometry, walk-away retention, rate limit) are delegated to normalizeHuddleName / evaluateHuddleJoin / keepsHuddleMembership / evaluateSendAllowance in @kaede/shared and unit-tested there

// The 立ち話グループ reducers (ROADMAP Phase 3 増分③): founding, joining
// and leaving the huddle-kind conversation_group rows. Unlike the zone
// reducers (zones.ts) these are open to EVERYONE in the world — founding a
// standing conversation is the whole point — so eligibility follows the
// posting precedent (presence in the world + the admission re-check,
// through findPostingSender) and every call is charged against the
// huddle_guard token bucket. The founding position comes from the SENDER'S
// authoritative player row, never from the client (the zones.ts rule), and
// join proximity is re-ruled server-side against the members' authoritative
// rows. The walk-away auto-leave is not here: it rides the group-occupancy
// pass (syncGroupOccupancy in world.ts) like the zone entry/exit judgment.
import {
  evaluateHuddleJoin,
  evaluateSendAllowance,
  GROUP_KIND_HUDDLE,
  HUDDLE_BURST_SENDS,
  HUDDLE_SEND_COST_MICROS,
  normalizeHuddleName,
  type SendAllowanceRequest,
  type SendAllowanceVerdict,
  ZONE_MAX,
} from '@kaede/shared';
import { SenderError, t } from 'spacetimedb/server';
import { spacetimedb } from './tables';
import {
  type Ctx,
  chargeSendAllowance,
  cleanupEmptyHuddle,
  findPostingSender,
  otherHuddleMemberPositions,
  type SenderIdentity,
  type WorldRows,
} from './world';

/**
 * The huddle token bucket (the chat numbers — see huddle_guard in
 * tables.ts). A local wrapper rather than a shared one, deliberately: a
 * shared evaluateHuddleSend would name the sendAllowance types in its
 * public signature and push the type-coupling evidence past its cap (the
 * rationale recorded in zone.ts's huddle section); the constants live in
 * shared and the bucket rule is the unit-tested evaluateSendAllowance.
 */
function evaluateHuddleSend(request: SendAllowanceRequest): SendAllowanceVerdict {
  return evaluateSendAllowance(request, HUDDLE_SEND_COST_MICROS, HUDDLE_BURST_SENDS);
}

/**
 * Moves the sender's membership onto `groupId` (founded or joined a
 * huddle): the insert/update, plus the empty-huddle cleanup for whatever
 * huddle the previous membership named — switching conversations may
 * leave one dying behind. A zone named by the previous membership just
 * gets left (cleanupEmptyHuddle is kind-checked): the explicit huddle
 * intent outranks standing geometry, and the occupancy pass will re-enter
 * the zone after the huddle ends if the member still stands inside it
 * (the design decision recorded on group_member in tables.ts).
 */
function moveMembershipToHuddle(ctx: Ctx, identity: SenderIdentity, groupId: bigint): void {
  const member = ctx.db.groupMember.identity.find(identity);
  if (member === null) {
    ctx.db.groupMember.insert({ identity, groupId });
    return;
  }
  const previous = member.groupId;
  ctx.db.groupMember.identity.update({ ...member, groupId });
  cleanupEmptyHuddle(ctx, previous);
}

// Founds a huddle where the sender stands (ROADMAP Phase 3 増分③): a
// kind='huddle' group row on the sender's map — the placement columns stay
// 0, the huddle's position derives from its members' avatars — with the
// sender as its first member. The cap is the shared conversation-group cap
// (ZONE_MAX counts all kinds: the occupancy pass and every entering
// client's subscription ride the row count, whatever the kind); it cannot
// be farmed, because founding moves the founder's membership and a huddle
// abandoned that way dies with its last member (cleanupEmptyHuddle), so
// one identity keeps at most one huddle alive. Refusals follow the posting
// loud/silent rule (see sendChatMessage): everything here throws before
// any write except the reclaim path, which stays a silent return.
export const createHuddle = spacetimedb.reducer(
  { name: t.string(), closed: t.bool() },
  (ctx, { name, closed }) => {
    const found = findPostingSender(ctx, 'create_huddle');
    if (!found) return;
    const verdict = normalizeHuddleName(name);
    if (!verdict.ok) throw new SenderError(`create_huddle refused (${verdict.reason})`);
    if (Number(ctx.db.conversationGroup.count()) >= ZONE_MAX) {
      throw new SenderError('create_huddle refused (group-limit)');
    }
    chargeSendAllowance(ctx, ctx.db.huddleGuard, evaluateHuddleSend, 'create_huddle');
    const inserted = ctx.db.conversationGroup.insert({
      id: 0n, // 0 asks autoInc to assign the real id
      kind: GROUP_KIND_HUDDLE,
      name: verdict.name,
      closed,
      mapId: found.row.mapId,
      x: 0,
      y: 0,
      w: 0,
      h: 0,
    });
    moveMembershipToHuddle(ctx, ctx.sender, inserted.id);
  },
);

/**
 * Vets one join_huddle call: `groupId` must name a huddle, and the
 * sender's authoritative row must pass the shared join geometry (same
 * map, within HUDDLE_JOIN_DISTANCE of a member — evaluateHuddleJoin).
 * Every refusal is loud and pre-write. Split from the reducer to keep
 * both uncovered functions under the CRAP budget fallow enforces.
 */
function vetHuddleJoin(ctx: Ctx, row: WorldRows['row'], groupId: bigint): void {
  const group = ctx.db.conversationGroup.id.find(groupId);
  if (group === null || group.kind !== GROUP_KIND_HUDDLE) {
    throw new SenderError('join_huddle refused (no-such-huddle)');
  }
  const verdict = evaluateHuddleJoin({
    position: { x: row.x, y: row.y },
    mapId: row.mapId,
    huddleMapId: group.mapId,
    memberPositions: otherHuddleMemberPositions(ctx, groupId, ctx.sender),
  });
  if (!verdict.ok) throw new SenderError(`join_huddle refused (${verdict.reason})`);
}

// Joins a huddle the sender walked up to (近づいて参加ボタン). The client's
// button offers only huddles the shared join rule accepts from its own
// rendered position (findJoinableHuddleId), but the authority is
// vetHuddleJoin above — the client is never trusted with geometry.
// Joining while in another group (a zone, or another huddle) switches the
// membership: the explicit act outranks whatever the sender was in, and
// identity-keyed membership makes "one conversation at a time" structural.
// Refusals follow the posting loud/silent rule; a join to the huddle
// already held is a silent no-op before the rate charge (a double-click
// must not burn the bucket).
export const joinHuddle = spacetimedb.reducer({ groupId: t.u64() }, (ctx, { groupId }) => {
  const found = findPostingSender(ctx, 'join_huddle');
  if (!found) return;
  const member = ctx.db.groupMember.identity.find(ctx.sender);
  if (member !== null && member.groupId === groupId) return;
  vetHuddleJoin(ctx, found.row, groupId);
  chargeSendAllowance(ctx, ctx.db.huddleGuard, evaluateHuddleSend, 'join_huddle');
  moveMembershipToHuddle(ctx, ctx.sender, groupId);
});

/**
 * The huddle the sender's membership currently names, or a loud refusal —
 * leave_huddle's target. Only a HUDDLE qualifies: zone membership is the
 * occupancy pass's alone (a client asking to leave the zone it stands in
 * would just be re-entered on its next movement, so offering the call
 * would be a lie). Split from the reducer for the CRAP budget.
 */
function requireOwnHuddleId(ctx: Ctx): bigint {
  const member = ctx.db.groupMember.identity.find(ctx.sender);
  const group = member === null ? null : ctx.db.conversationGroup.id.find(member.groupId);
  if (group === null || group.kind !== GROUP_KIND_HUDDLE) {
    throw new SenderError('leave_huddle refused (not-in-huddle)');
  }
  return group.id;
}

// Leaves the sender's huddle (the explicit 抜ける button — the walk-away
// auto-leave is syncGroupOccupancy's). A leave that empties the huddle
// deletes the group row (cleanupEmptyHuddle). Refusals follow the posting
// loud/silent rule; leaving while in no huddle throws so a stale client
// hears it rather than believing it left something.
export const leaveHuddle = spacetimedb.reducer((ctx) => {
  const found = findPostingSender(ctx, 'leave_huddle');
  if (!found) return;
  const huddleId = requireOwnHuddleId(ctx);
  chargeSendAllowance(ctx, ctx.db.huddleGuard, evaluateHuddleSend, 'leave_huddle');
  ctx.db.groupMember.identity.delete(ctx.sender);
  cleanupEmptyHuddle(ctx, huddleId);
});
