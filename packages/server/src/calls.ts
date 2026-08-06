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
  CAPABILITY_SCOPE_RECORDING,
  evaluateSendAllowance,
  isMeetingIdLike,
  isRecordingFileNameLike,
  mintCapability,
  RECORDING_HISTORY_MAX,
  RECORDING_PASS_TTL_SECONDS,
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
 * Refuses the call unless the sender is an APPROVED member — the shared
 * gate of the recording reducers (the label write and the pass mint),
 * mirroring the Worker's route gate: recording is 承認済みメンバー限定
 * (増分④ 設計①), so a guest or an unapproved sign-in reaching either
 * reducer is a hand-rolled client. Loud and pre-write.
 */
function requireApprovedMember(ctx: Ctx, reducerName: string): void {
  if (membershipOf(ctx, ctx.sender)?.status !== 'approved') {
    throw new SenderError(`${reducerName} refused (not-a-member)`);
  }
}

/**
 * Vets one recording label: an approved-member sender and a
 * provider-shaped file name. Every refusal is loud and pre-write (the
 * vetCallRegistration shape); the group half lives in recordingGroupName
 * so both stay under the CRAP budget.
 */
function vetRecordingLog(ctx: Ctx, fileName: string): void {
  requireApprovedMember(ctx, 'log_group_recording');
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

// ── The recording pass (ROADMAP Phase 4 増分⑤) ──────────────────────────

/**
 * The anchor secret this module signs recording passes with, or a loud
 * refusal while the anchor is unprovisioned (the worker_anchor table
 * comment — the row is seeded by owner SQL, never by a reducer). An
 * unprovisioned anchor keeps the recording routes closed on BOTH sides:
 * nothing mints here, and the Worker's empty secret list verifies
 * nothing.
 */
function anchorSecret(ctx: Ctx): string {
  const secret = ctx.db.workerAnchor.id.find(0)?.secret ?? '';
  if (secret === '') {
    throw new SenderError('mint_recording_pass refused (anchor-not-provisioned)');
  }
  return secret;
}

/** Upserts the sender's pass row (the reaction upsert shape). */
function upsertRecordingPass(ctx: Ctx, pass: string): void {
  const existing = ctx.db.recordingPass.identity.find(ctx.sender);
  if (existing) {
    ctx.db.recordingPass.identity.update({ ...existing, pass });
    return;
  }
  ctx.db.recordingPass.insert({ identity: ctx.sender, pass });
}

/**
 * The provider subject to bind the pass to: the sender's account row's
 * `subject` (the Clerk user id clientConnected records — see the column
 * comment in tables.ts). Present on every member connection by
 * construction — clientConnected backfills it before any reducer of the
 * same connection can run — so the refusal is the transitionMember rule:
 * an "unreachable" branch must not read as a silent no-op.
 */
function recordingPassSubject(ctx: Ctx): string {
  const subject = ctx.db.account.identity.find(ctx.sender)?.subject ?? '';
  if (subject === '') {
    throw new SenderError('mint_recording_pass refused (no-subject)');
  }
  return subject;
}

// Mints the sender's short-lived recording pass: the signed capability
// the Worker's recording routes demand on top of the member bearer —
// which is how the APPROVAL state only this module knows gets enforced at
// the Worker without the Worker reading this database (増分⑤ closing the
// 増分④ 設計① accepted looseness; the anchor design is the ROADMAP 増分⑤
// entry). Eligibility is the posting preamble (in the world + admission
// re-check — a pending member cannot even be in the world) plus the
// approved-membership gate the other recording reducer shares
// (requireApprovedMember); the rate charge rides call_guard like the rest
// of the call flow (same UI surface, no client-side mirror to drift
// from). The pass reaches its holder through the recording_pass row,
// which RLS narrows to the sender alone (recordingPassVisibility) — a
// reducer cannot return a value, so the row IS the delivery channel. The
// pass's subject is the sender's CLERK user id, not the SpacetimeDB
// Identity: the Worker binds the pass to the bearer it verified (same
// subject or 403), so a pass leaked to any other signed-in identity buys
// nothing (a Bugbot finding on the first cut). The claims are entirely
// server-made (the stored subject, the server clock), so mintCapability's
// undefined branch is unreachable here; it still refuses loudly rather
// than writing an empty pass.
export const mintRecordingPass = spacetimedb.reducer((ctx) => {
  if (!findPostingSender(ctx, 'mint_recording_pass')) return;
  requireApprovedMember(ctx, 'mint_recording_pass');
  const subject = recordingPassSubject(ctx);
  const secret = anchorSecret(ctx);
  chargeCallAllowance(ctx, 'mint_recording_pass');
  const pass = mintCapability(
    {
      scope: CAPABILITY_SCOPE_RECORDING,
      subject,
      expSeconds:
        Number(ctx.timestamp.microsSinceUnixEpoch / 1_000_000n) + RECORDING_PASS_TTL_SECONDS,
    },
    secret,
  );
  if (pass === undefined) {
    throw new SenderError('mint_recording_pass refused (unmintable)');
  }
  upsertRecordingPass(ctx, pass);
});
