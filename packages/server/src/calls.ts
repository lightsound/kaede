// fallow-ignore-file coverage-gaps -- a reducer only runs inside a SpacetimeDB module host, so no unit test can import this file; the rules worth testing (meeting-id shape, recording status, rate limit) are delegated to isMeetingIdLike / isRecordingIdLike / isRecordingStatus / evaluateSendAllowance in @kaede/shared and unit-tested there

// The group-call registration reducer (ROADMAP Phase 4 増分①〜②) and the
// recording catalog reducers (増分④). The call flow splits authority in two:
// the WORKER (packages/worker) talks to the call provider — it provisions
// meetings, mints participant tokens, starts/stops recordings and receives
// webhooks, because those need the provider secret — while THIS module
// remains the only group (and recording-catalog) authority. The Worker
// never becomes group authority: knowing a meeting id is still the join
// capability (group_call RLS), and recording rows are written here after
// membership / service-secret checks.
import {
  CALL_BURST_SENDS,
  CALL_SEND_COST_MICROS,
  evaluateSendAllowance,
  isMeetingIdLike,
  isRecordingIdLike,
  isRecordingStatus,
  RECORDING_HISTORY_MAX,
  RECORDING_STATUS_RECORDING,
} from '@kaede/shared';
import { SenderError, t } from 'spacetimedb/server';
import { spacetimedb } from './tables';
import { type Ctx, chargeSendAllowance, findPostingSender, requireAdmin } from './world';

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
    chargeSendAllowance(
      ctx,
      ctx.db.callGuard,
      (request) => evaluateSendAllowance(request, CALL_SEND_COST_MICROS, CALL_BURST_SENDS),
      'register_group_call',
    );
    ctx.db.groupCall.insert({ groupId, meetingId });
  },
);

// ── Recordings (増分④) ──────────────────────────────────────────────────

/**
 * Vets a member-side recording registration: shapes, sender is an
 * APPROVED space member in a group whose call row matches `meetingId`.
 * Guests can mint call tokens (増分②) but cannot open the recording
 * catalog — that is the access-control decision in ROADMAP/VISION.
 * Returns the groupId to stamp on the row. Split for the CRAP budget.
 */
function vetRecordingRegistration(ctx: Ctx, recordingId: string, meetingId: string): bigint {
  if (!isRecordingIdLike(recordingId)) {
    throw new SenderError('register_call_recording refused (invalid-recording-id)');
  }
  if (!isMeetingIdLike(meetingId)) {
    throw new SenderError('register_call_recording refused (invalid-meeting-id)');
  }
  const membership = ctx.db.spaceMember.identity.find(ctx.sender);
  if (membership === null || membership.status !== 'approved') {
    throw new SenderError('register_call_recording refused (not-approved-member)');
  }
  const member = ctx.db.groupMember.identity.find(ctx.sender);
  if (member === null) {
    throw new SenderError('register_call_recording refused (not-in-a-group)');
  }
  const call = ctx.db.groupCall.groupId.find(member.groupId);
  if (call === null || call.meetingId !== meetingId) {
    throw new SenderError('register_call_recording refused (meeting-mismatch)');
  }
  return member.groupId;
}

/** Drops the oldest call_recording rows past RECORDING_HISTORY_MAX. */
function trimCallRecordings(ctx: Ctx): void {
  const rows = [...ctx.db.callRecording.iter()];
  if (rows.length <= RECORDING_HISTORY_MAX) return;
  rows.sort((a, b) => {
    if (a.startedAtMs === b.startedAtMs) {
      return a.recordingId < b.recordingId ? -1 : a.recordingId > b.recordingId ? 1 : 0;
    }
    return a.startedAtMs < b.startedAtMs ? -1 : 1;
  });
  const overflow = rows.length - RECORDING_HISTORY_MAX;
  for (let i = 0; i < overflow; i += 1) {
    const row = rows[i];
    if (row !== undefined) ctx.db.callRecording.recordingId.delete(row.recordingId);
  }
}

/**
 * Member-side insert of a recording catalog row. Called from the client
 * when a recording starts (UI Kit toggle or Worker start — both surface a
 * recording id). Idempotent on recordingId: a second register of the same
 * id is a no-op (webhook may race ahead and insert first).
 */
export const registerCallRecording = spacetimedb.reducer(
  {
    recordingId: t.string(),
    meetingId: t.string(),
    startedAtMs: t.u64(),
  },
  (ctx, { recordingId, meetingId, startedAtMs }) => {
    if (!findPostingSender(ctx, 'register_call_recording')) return;
    const groupId = vetRecordingRegistration(ctx, recordingId, meetingId);
    if (ctx.db.callRecording.recordingId.find(recordingId) !== null) return;
    ctx.db.callRecording.insert({
      recordingId,
      meetingId,
      groupId,
      status: RECORDING_STATUS_RECORDING,
      objectKey: '',
      outputFileName: '',
      startedAtMs,
      durationSecs: 0,
      spaceFlag: 0,
    });
    trimCallRecordings(ctx);
  },
);

/** True when the presented service secret matches the private row. */
function serviceSecretOk(ctx: Ctx, secret: string): boolean {
  if (secret === '') return false;
  const row = ctx.db.callServiceSecret.id.find(0);
  return row !== null && row.secret === secret;
}

/**
 * Resolves the groupId for a webhook upsert: prefer an existing catalog
 * row, else the group_call row keyed by meetingId (indexed). Undefined
 * when neither exists — a recording for a meeting we never registered.
 */
function groupIdForRecording(
  ctx: Ctx,
  recordingId: string,
  meetingId: string,
): bigint | undefined {
  const existing = ctx.db.callRecording.recordingId.find(recordingId);
  if (existing !== null) return existing.groupId;
  for (const call of ctx.db.groupCall.meetingId.filter(meetingId)) {
    return call.groupId;
  }
  return undefined;
}

/**
 * Webhook-relayed status upsert (Worker → this reducer with the shared
 * service secret). Inserts if the member-side register has not landed yet
 * (webhook can win the race); updates status/objectKey/duration otherwise.
 * Refuses unknown statuses and unknown meetings (no group_call and no
 * prior row) so a forged webhook cannot invent catalog entries for
 * meetings outside this space.
 */
export const upsertCallRecordingStatus = spacetimedb.reducer(
  {
    secret: t.string(),
    recordingId: t.string(),
    meetingId: t.string(),
    status: t.string(),
    objectKey: t.string(),
    outputFileName: t.string(),
    startedAtMs: t.u64(),
    durationSecs: t.u32(),
  },
  (ctx, args) => {
    if (!serviceSecretOk(ctx, args.secret)) {
      throw new SenderError('upsert_call_recording_status refused (unauthorized)');
    }
    if (!isRecordingIdLike(args.recordingId) || !isMeetingIdLike(args.meetingId)) {
      throw new SenderError('upsert_call_recording_status refused (invalid-id)');
    }
    if (!isRecordingStatus(args.status)) {
      throw new SenderError('upsert_call_recording_status refused (invalid-status)');
    }
    const groupId = groupIdForRecording(ctx, args.recordingId, args.meetingId);
    if (groupId === undefined) {
      throw new SenderError('upsert_call_recording_status refused (unknown-meeting)');
    }
    const existing = ctx.db.callRecording.recordingId.find(args.recordingId);
    if (existing === null) {
      ctx.db.callRecording.insert({
        recordingId: args.recordingId,
        meetingId: args.meetingId,
        groupId,
        status: args.status,
        objectKey: args.objectKey,
        outputFileName: args.outputFileName,
        startedAtMs: args.startedAtMs,
        durationSecs: args.durationSecs,
        spaceFlag: 0,
      });
      trimCallRecordings(ctx);
      return;
    }
    ctx.db.callRecording.recordingId.update({
      ...existing,
      status: args.status,
      // Empty webhook fields must not wipe values the member register or a
      // prior upsert already filled (partial status transitions).
      objectKey: args.objectKey === '' ? existing.objectKey : args.objectKey,
      outputFileName:
        args.outputFileName === '' ? existing.outputFileName : args.outputFileName,
      startedAtMs: args.startedAtMs === 0n ? existing.startedAtMs : args.startedAtMs,
      durationSecs: args.durationSecs === 0 ? existing.durationSecs : args.durationSecs,
    });
  },
);

/**
 * Admin-only write of the Worker↔module service secret (id 0 upsert).
 * Rotation is the same call. The value never leaves this private table —
 * clients cannot subscribe to it.
 */
export const setCallServiceSecret = spacetimedb.reducer(
  { secret: t.string() },
  (ctx, { secret }) => {
    requireAdmin(ctx, 'set_call_service_secret');
    if (secret === '' || secret.length > 256) {
      throw new SenderError('set_call_service_secret refused (invalid-secret)');
    }
    const existing = ctx.db.callServiceSecret.id.find(0);
    if (existing === null) {
      ctx.db.callServiceSecret.insert({ id: 0, secret });
    } else {
      ctx.db.callServiceSecret.id.update({ id: 0, secret });
    }
  },
);
