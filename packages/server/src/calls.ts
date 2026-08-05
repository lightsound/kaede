// fallow-ignore-file coverage-gaps -- a reducer only runs inside a SpacetimeDB module host, so no unit test can import this file; the rules worth testing (meeting-id shape, rate limit) are delegated to isMeetingIdLike / evaluateSendAllowance in @kaede/shared and unit-tested there

// The group-call registration reducer (ROADMAP Phase 4 増分①). The call
// flow splits authority in two: the WORKER (packages/worker) talks to the
// call provider — it provisions meetings and mints participant tokens,
// because those need the provider secret — while THIS module remains the
// only group authority: which conversation group has which meeting is a
// group_call row, written here after the standing membership checks, and
// read back under the members-only RLS filter (groupCallVisibility in
// tables.ts). The reducer never talks to the provider (SpacetimeDB modules
// cannot call external HTTP), and the Worker never talks to this module —
// the row is their only meeting point.
import {
  CALL_BURST_SENDS,
  CALL_SEND_COST_MICROS,
  evaluateSendAllowance,
  isMeetingIdLike,
} from '@kaede/shared';
import { SenderError, t } from 'spacetimedb/server';
import { spacetimedb } from './tables';
import { type Ctx, chargeSendAllowance, findPostingSender, membershipOf } from './world';

// Registers the sender's conversation group's call: binds the meeting the
// Worker just provisioned to the group the sender is IN — the group is
// never named by the client (the create_zone placement rule applied to
// membership: the row addresses what the server knows about the sender,
// not what the sender claims). Eligibility is the posting preamble (in the
// world + admission re-check) plus holding a group membership, plus being
// an APPROVED MEMBER — unlike huddling, deliberately: a registration is a
// claim that the provider issued this meeting id, which only someone the
// Worker will mint for (a signed-in member) can honestly make. A guest
// could otherwise write a well-formed-but-dead id and wedge the group's
// call until the group dies (guests cannot join calls in this increment
// anyway — the Worker refuses them).
//
// Refusals follow the posting loud/silent rule (everything throws before
// any write). `already-registered` is the expected two-members-race
// outcome: the loser's provisioned meeting is simply never referenced
// (the provider holds idle meetings at no cost), and the loser joins the
// row that won — the client handles the refusal by re-reading the row.
/**
 * Vets one registration: a provider-shaped meeting id, a sender who IS in
 * a group, and no call registered for it yet. Returns the group to bind.
 * Every refusal is loud and pre-write. Split from the reducer to keep
 * both uncovered functions under the CRAP budget (the vetHuddleJoin
 * precedent).
 */
function vetCallRegistration(ctx: Ctx, meetingId: string): bigint {
  if (!isMeetingIdLike(meetingId)) {
    throw new SenderError('register_group_call refused (invalid-meeting-id)');
  }
  const member = ctx.db.groupMember.identity.find(ctx.sender);
  if (member === null) throw new SenderError('register_group_call refused (not-in-a-group)');
  if (ctx.db.groupCall.groupId.find(member.groupId) !== null) {
    throw new SenderError('register_group_call refused (already-registered)');
  }
  return member.groupId;
}

export const registerGroupCall = spacetimedb.reducer(
  { meetingId: t.string() },
  (ctx, { meetingId }) => {
    if (!findPostingSender(ctx, 'register_group_call')) return;
    // The members-only gate (see the header comment): guests pass the
    // posting preamble but must not bind meeting ids they can never mint.
    if (membershipOf(ctx, ctx.sender)?.status !== 'approved') {
      throw new SenderError('register_group_call refused (members-only)');
    }
    const groupId = vetCallRegistration(ctx, meetingId);
    // The token bucket (the huddle numbers — see call_guard in tables.ts).
    // The evaluator stays an inline arrow rather than a shared wrapper, for
    // the standing reason: a shared wrapper's signature would push the
    // type-coupling evidence past its cap (the evaluateHuddleSend rationale).
    chargeSendAllowance(
      ctx,
      ctx.db.callGuard,
      (request) => evaluateSendAllowance(request, CALL_SEND_COST_MICROS, CALL_BURST_SENDS),
      'register_group_call',
    );
    ctx.db.groupCall.insert({ groupId, meetingId });
  },
);
