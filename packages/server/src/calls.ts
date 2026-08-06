// fallow-ignore-file coverage-gaps -- a reducer only runs inside a SpacetimeDB module host, so no unit test can import this file; the rules worth testing (meeting-id shape, recording file-name shape, rate limit) are delegated to isMeetingIdLike / isRecordingFileNameLike / evaluateSendAllowance in @kaede/shared and unit-tested there

// The group-call reducers (ROADMAP Phase 4 増分①〜②・④): registering a
// group's meeting, and labeling its recordings (log_group_recording). The
// call flow splits authority in two: the WORKER (packages/worker) talks to
// the call provider — it provisions meetings and mints participant tokens,
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
  isRecordingFileNameLike,
  RECORDING_HISTORY_MAX,
} from '@kaede/shared';
import { SenderError, t } from 'spacetimedb/server';
import { spacetimedb } from './tables';
import {
  type Ctx,
  chargeSendAllowance,
  findPostingSender,
  membershipOf,
  trimHistory,
  type WorldRows,
} from './world';

// Registers the sender's conversation group's call: binds the meeting the
// Worker just provisioned to the group the sender is IN — the group is
// never named by the client (the create_zone placement rule applied to
// membership: the row addresses what the server knows about the sender,
// not what the sender claims). Eligibility is the posting preamble (in the
// world + admission re-check) plus holding a group membership — GUESTS
// INCLUDED since 増分② (the huddle rule): a registration is a claim that
// the provider issued this meeting id, which only someone the Worker will
// mint for can honestly make, and the Worker now mints for every in-world
// identity (a member's Clerk JWT or a guest's host-issued token). 増分①
// gated this to approved members because guests could not mint at all —
// every guest registration would have been a well-formed-but-dead id
// wedging the group's call (a review finding); that premise is what 増分②
// lifts, not the vetting. DELIBERATE dead-id vandalism stays possible for
// anyone in-world — the chat-spam trust level, bounded by the same levers
// (call_guard below; guests_allowed kicks guests out of the posting
// preamble entirely).
//
// Refusals follow the posting loud/silent rule (everything throws before
// any write). `already-registered` is the expected two-senders-race
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
    const groupId = vetCallRegistration(ctx, meetingId);
    // The token bucket (the huddle numbers — see call_guard in tables.ts).
    // The evaluator stays an inline arrow rather than a shared wrapper, for
    // the standing reason: a shared wrapper's signature would push the
    // type-coupling evidence past its cap (the evaluateHuddleSend rationale).
    chargeCallAllowance(ctx, 'register_group_call');
    ctx.db.groupCall.insert({ groupId, meetingId });
  },
);

/**
 * Charges one call-flow send against call_guard — shared by
 * register_group_call and log_group_recording, which are the same UI
 * flow's low-frequency operations with no client-side mirror to drift
 * from (the one reason every other feature gets a bucket of its own).
 * The evaluator stays an inline arrow for the standing type-coupling
 * reason (see registerGroupCall).
 */
function chargeCallAllowance(ctx: Ctx, reducerName: string): void {
  chargeSendAllowance(
    ctx,
    ctx.db.callGuard,
    (request) => evaluateSendAllowance(request, CALL_SEND_COST_MICROS, CALL_BURST_SENDS),
    reducerName,
  );
}

/**
 * Vets one recording label: an approved-member sender (mirroring the
 * Worker's gate — recording start is members-only, so only a member ever
 * has a fileName to log; a guest reaching this reducer is a hand-rolled
 * client) and a provider-shaped file name. Every refusal is loud and
 * pre-write (the vetCallRegistration shape); the group half lives in
 * recordingGroupName so both stay under the CRAP budget.
 */
function vetRecordingLog(ctx: Ctx, fileName: string): void {
  if (membershipOf(ctx, ctx.sender)?.status !== 'approved') {
    throw new SenderError('log_group_recording refused (not-a-member)');
  }
  if (!isRecordingFileNameLike(fileName)) {
    throw new SenderError('log_group_recording refused (invalid-file-name)');
  }
}

/** The sender's group's display name to snapshot, or a loud refusal. */
function recordingGroupName(ctx: Ctx): string {
  const member = ctx.db.groupMember.identity.find(ctx.sender);
  if (member === null) throw new SenderError('log_group_recording refused (not-in-a-group)');
  const group = ctx.db.conversationGroup.id.find(member.groupId);
  if (group === null) throw new SenderError('log_group_recording refused (group-gone)');
  return group.name;
}

/**
 * Writes the label row and trims the history — split from the reducer to
 * keep both uncovered functions under the CRAP budget (the
 * vetCallRegistration precedent).
 */
function appendRecordingLabel(ctx: Ctx, rows: WorldRows, fileName: string, groupName: string) {
  ctx.db.callRecording.insert({
    id: 0n, // 0 asks autoInc to assign the real id
    fileName,
    groupName,
    starterName: rows.nameRow.name,
    startedAt: ctx.timestamp,
  });
  trimHistory(ctx.db.callRecording, RECORDING_HISTORY_MAX);
}

// Labels the recording the sender just started: one call_recording row —
// the human-readable side of the R2 listing (see the table comment in
// tables.ts for the whole design: the row is a LABEL, the R2 object is the
// truth). Both names are resolved from the server's own rows — the group's
// name from the membership the sender holds, the starter's from its
// player_name row — so the client claims nothing but the provider-shaped
// fileName (the register_group_call vetting philosophy). Called by the
// starter's client right after the Worker's start call succeeds; a lost
// label (rate refusal, disconnect) degrades that recording's listing to
// date-only, never blocks the recording itself.
export const logGroupRecording = spacetimedb.reducer(
  { fileName: t.string() },
  (ctx, { fileName }) => {
    const rows = findPostingSender(ctx, 'log_group_recording');
    if (!rows) return;
    vetRecordingLog(ctx, fileName);
    const groupName = recordingGroupName(ctx);
    chargeCallAllowance(ctx, 'log_group_recording');
    appendRecordingLabel(ctx, rows, fileName, groupName);
  },
);
