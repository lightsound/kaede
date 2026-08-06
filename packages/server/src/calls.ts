// fallow-ignore-file coverage-gaps -- procedures only run inside a SpacetimeDB module host, so no unit test can import this file; the rules worth testing (file-name shape, rate limit, SigV4 signing, listing parse) are delegated to @kaede/shared and unit-tested there

// The group-call and recording procedures (ROADMAP Phase 4 増分①〜⑥).
// Since 増分⑥ this module is BOTH the group authority and the external API
// boundary: a procedure checks membership/approval and calls the provider
// in one place (`ctx.withTx` for the database halves, `ctx.http` for the
// synchronous outbound HTTP), and `ctx.sender` — the authenticated
// SpacetimeDB connection — is the caller's identity, so no bearer
// verification stack and no Worker⇄module trust anchor exists anymore
// (the 増分⑤ mechanism, retired by 増分⑥; VISION バックエンド行).
//
// Every procedure follows the D3 charge rule: a first transaction vets
// the sender and CHARGES the rate bucket, then the external HTTP runs
// outside any transaction (a procedure cannot hold one open across it),
// then a result transaction writes the outcome. An HTTP failure after the
// charge leaves the charge standing — accepted (no refunds; the bucket
// refills within seconds). Refusals inside a transaction throw before any
// write (the posting loud/silent rule); the one silent case is the
// reclaimed sender, which must COMMIT its reclaim and therefore surfaces
// as a marker the procedure turns into a refusal after the commit.
import {
  CALL_BURST_SENDS,
  CALL_SEND_COST_MICROS,
  evaluateSendAllowance,
  isRecordingFileNameLike,
  RECORDING_HISTORY_MAX,
} from '@kaede/shared';
import { SenderError, t } from 'spacetimedb/server';
import {
  type CallConfig,
  createMeeting,
  listRecordingObjects,
  mintParticipantToken,
  presignRecordingDownload,
  startCloudRecording,
  stopCloudRecording,
} from './provider';
import { spacetimedb } from './tables';
import {
  type Ctx,
  chargeSendAllowance,
  findPostingSender,
  membershipOf,
  trimHistory,
} from './world';

/**
 * Charges one call-flow send against call_guard — shared by every
 * procedure here: they are the same UI flow's low-frequency operations
 * with no client-side mirror to drift from (the one reason every other
 * feature gets a bucket of its own). The evaluator stays an inline arrow
 * rather than a shared wrapper, for the standing reason: a shared
 * wrapper's signature would push the type-coupling evidence past its cap
 * (the evaluateHuddleSend rationale).
 */
function chargeCallAllowance(ctx: Ctx, procedureName: string): void {
  chargeSendAllowance(
    ctx,
    ctx.db.callGuard,
    (request) => evaluateSendAllowance(request, CALL_SEND_COST_MICROS, CALL_BURST_SENDS),
    procedureName,
  );
}

/**
 * Refuses the call unless the sender is an APPROVED member — the shared
 * gate of the recording procedures: recording is 承認済みメンバー限定
 * (増分④ 設計①, enforced here since 増分⑥ replaced the Worker gate), so
 * a guest or an unapproved sign-in reaching one is a hand-rolled client.
 * Loud and pre-write.
 */
function requireApprovedMember(ctx: Ctx, procedureName: string): void {
  if (membershipOf(ctx, ctx.sender)?.status !== 'approved') {
    throw new SenderError(`${procedureName} refused (not-a-member)`);
  }
}

/**
 * The provider configuration, or a loud refusal while unprovisioned (the
 * call_config table comment — the row is seeded by owner SQL, never by a
 * reducer). Fail closed: nothing dials out until the owner provisions.
 */
function callConfigOf(ctx: Ctx, procedureName: string): CallConfig {
  const cfg = ctx.db.callConfig.id.find(0);
  if (cfg === null) {
    throw new SenderError(`${procedureName} refused (call-config-not-provisioned)`);
  }
  return cfg;
}

/**
 * The provider-side participant id for the sender: a member's Clerk
 * subject (the account row's connect-time fact — see tables.ts), a
 * guest's Identity hex. Recorded as custom_participant_id for future
 * correlation (recording access, cost attribution).
 */
function participantIdOf(ctx: Ctx): string {
  const subject = ctx.db.account.identity.find(ctx.sender)?.subject ?? '';
  return subject === '' ? ctx.sender.toHexString() : subject;
}

/** What the join's charge transaction hands the HTTP half. */
interface JoinSetup {
  groupId: bigint;
  /** The group's registered meeting, or undefined when one must be provisioned. */
  meetingId: string | undefined;
  /** The sender's display name — what the call tile shows the others. */
  name: string;
  participantId: string;
  cfg: CallConfig;
}

/**
 * The join's charge transaction: vets the sender (posting preamble —
 * guests included, the 増分② product rule: ゲストも通話の開始・参加・
 * 画面共有はメンバー同等), resolves its group and the group's registered
 * call, and charges the bucket. Undefined marks the reclaimed sender
 * (committed — the caller refuses after).
 */
function joinSetupIn(tx: Ctx): JoinSetup | undefined {
  const rows = findPostingSender(tx, 'join_group_call');
  if (!rows) return undefined;
  const member = tx.db.groupMember.identity.find(tx.sender);
  if (member === null) throw new SenderError('join_group_call refused (not-in-a-group)');
  const cfg = callConfigOf(tx, 'join_group_call');
  chargeCallAllowance(tx, 'join_group_call');
  return {
    groupId: member.groupId,
    meetingId: tx.db.groupCall.groupId.find(member.groupId)?.meetingId,
    name: rows.nameRow.name,
    participantId: participantIdOf(tx),
    cfg,
  };
}

/**
 * The join's result transaction: binds the meeting this procedure just
 * provisioned to the sender's CURRENT group — re-resolved, because the
 * sender may have walked between the charge and the provision landing
 * (~1s of provider HTTP). Two senders racing to start the same group's
 * call both provision; the first result transaction inserts the row and
 * the second finds it and ADOPTS the winner's meeting (増分⑥ D4 — the
 * loser's provisioned meeting is simply never referenced; the provider
 * holds idle meetings at no cost). The returned groupId is the group the
 * ticket is actually bound to — the client's auto-leave watch compares
 * it against where the user now stands.
 */
function bindProvisionedMeeting(
  tx: Ctx,
  provisioned: string,
): { groupId: bigint; meetingId: string } {
  const member = tx.db.groupMember.identity.find(tx.sender);
  if (member === null) throw new SenderError('join_group_call refused (left-the-group)');
  const existing = tx.db.groupCall.groupId.find(member.groupId);
  if (existing !== null) return { groupId: member.groupId, meetingId: existing.meetingId };
  tx.db.groupCall.insert({ groupId: member.groupId, meetingId: provisioned });
  return { groupId: member.groupId, meetingId: provisioned };
}

// Joins the sender's conversation group's call: reuses the group's
// registered meeting, or provisions one at the provider and binds it via
// the group_call row (whose members-only RLS filter remains the read-side
// capability — the table comment in tables.ts), then mints the
// participant token the client dials with. The 増分⑥ D4 consolidation of
// what used to be three round-trips (Worker provision → register reducer
// → Worker mint) with a client-side race-recovery loop (flow.ts,
// retired): the race resolves in bindProvisionedMeeting's transaction
// instead. The group is never named by the client (the create_zone
// placement rule applied to membership), and the display name comes from
// the sender's own player_name row — nothing here is client-claimed.
export const joinGroupCall = spacetimedb.procedure(
  t.object('CallTicket', { groupId: t.u64(), authToken: t.string() }),
  (ctx) => {
    const setup = ctx.withTx((tx) => joinSetupIn(tx));
    if (setup === undefined) throw new SenderError('join_group_call refused (reclaimed)');
    let bound = { groupId: setup.groupId, meetingId: setup.meetingId };
    if (bound.meetingId === undefined) {
      const provisioned = createMeeting(ctx.http, setup.cfg);
      bound = ctx.withTx((tx) => bindProvisionedMeeting(tx, provisioned));
    }
    return {
      groupId: bound.groupId,
      authToken: mintParticipantToken(
        ctx.http,
        setup.cfg,
        bound.meetingId as string,
        setup.name,
        setup.participantId,
      ),
    };
  },
);

/** What a recording-control charge transaction hands the HTTP half. */
interface RecordingSetup {
  meetingId: string;
  /** Label snapshots (the call_recording table comment). */
  groupName: string;
  starterName: string;
  cfg: CallConfig;
}

/**
 * The sender's group's registered call and the group's display name, or a
 * loud refusal. Split from recordingControlSetupIn to keep both uncovered
 * functions under the CRAP budget (the vetCallRegistration precedent).
 */
function recordingCallOf(tx: Ctx, procedureName: string, groupId: bigint) {
  const call = tx.db.groupCall.groupId.find(groupId);
  if (call === null) throw new SenderError(`${procedureName} refused (no-call-registered)`);
  const group = tx.db.conversationGroup.id.find(groupId);
  if (group === null) throw new SenderError(`${procedureName} refused (group-gone)`);
  return { meetingId: call.meetingId, groupName: group.name };
}

/**
 * The recording controls' charge transaction: the posting preamble PLUS
 * the approved-member gate (録画は承認済みメンバー限定 — 増分④ 設計①),
 * the registered call of the group the CLIENT's in-call ticket named,
 * and the charge. The ticket's groupId is a CONSISTENCY CHECK, not an
 * authority transfer: the sender's live membership must still name that
 * group, or the call is refused — so a control clicked in the auto-leave
 * window (walked off mid-call, WebRTC teardown pending, membership
 * already elsewhere) refuses loudly instead of silently addressing the
 * NEW group's call (a Bugbot finding), while a guessed groupId for a
 * group the sender is not in buys nothing (group ids are sequential and
 * guessable, unlike the retired Worker's meeting-id capability — naming
 * alone must not open another conversation's recording controls).
 * Undefined marks the reclaimed sender (the joinSetupIn contract).
 */
function recordingControlSetupIn(
  tx: Ctx,
  procedureName: string,
  groupId: bigint,
): RecordingSetup | undefined {
  const rows = findPostingSender(tx, procedureName);
  if (!rows) return undefined;
  requireApprovedMember(tx, procedureName);
  const member = tx.db.groupMember.identity.find(tx.sender);
  if (member === null || member.groupId !== groupId) {
    throw new SenderError(`${procedureName} refused (not-in-that-group)`);
  }
  const call = recordingCallOf(tx, procedureName, groupId);
  const cfg = callConfigOf(tx, procedureName);
  chargeCallAllowance(tx, procedureName);
  return { ...call, starterName: rows.nameRow.name, cfg };
}

/**
 * The start's result transaction: the call_recording label row — written
 * server-side since 増分⑥ (the old log_group_recording reducer let the
 * starter's client claim the fileName; now the provider's answer flows
 * straight in, so nothing about the label is client-claimed) — plus the
 * retention trim.
 */
function appendRecordingLabel(tx: Ctx, fileName: string, setup: RecordingSetup): void {
  tx.db.callRecording.insert({
    id: 0n, // 0 asks autoInc to assign the real id
    fileName,
    groupName: setup.groupName,
    starterName: setup.starterName,
    startedAt: tx.timestamp,
  });
  trimHistory(tx.db.callRecording, RECORDING_HISTORY_MAX);
}

// Starts the cloud recording of the ticket-named group's call (増分④→⑥):
// the recording uploads straight to R2 (storage_config — the credentials
// live in call_config and never leave the server), and the label row is
// written by the result transaction. Returns the provider-fixed file
// basename. A lost label (a crash between the HTTP and the result
// transaction, a failed label write) degrades that recording's listing to
// date-only, exactly the 増分④ failure mode — never a start failure: the
// provider is already recording by then, so rejecting would report a
// failure over a running recording and invite a duplicate start (the old
// fire-and-forget log_group_recording contract, carried over).
export const startGroupRecording = spacetimedb.procedure(
  { groupId: t.u64() },
  t.string(),
  (ctx, { groupId }) => {
    const setup = ctx.withTx((tx) => recordingControlSetupIn(tx, 'start_group_recording', groupId));
    if (setup === undefined) throw new SenderError('start_group_recording refused (reclaimed)');
    const fileName = startCloudRecording(ctx.http, setup.cfg, setup.meetingId);
    try {
      ctx.withTx((tx) => appendRecordingLabel(tx, fileName, setup));
    } catch (err) {
      console.error('start_group_recording label write failed', fileName, err);
    }
    return fileName;
  },
);

// Stops the active recording of the ticket-named group's call. False
// means there was none — a benign race (the unattended auto-stop, another
// member's stop), reported as an answer rather than a refusal: the
// outcome the user asked for is true either way (the Worker's tolerated
// 404, carried over).
export const stopGroupRecording = spacetimedb.procedure(
  { groupId: t.u64() },
  t.bool(),
  (ctx, { groupId }) => {
    const setup = ctx.withTx((tx) => recordingControlSetupIn(tx, 'stop_group_recording', groupId));
    if (setup === undefined) throw new SenderError('stop_group_recording refused (reclaimed)');
    return stopCloudRecording(ctx.http, setup.cfg, setup.meetingId) === 'stopped';
  },
);

/**
 * The recording reads' charge transaction: approved members only, like
 * the Worker routes these replace — deliberately WITHOUT the in-world
 * preamble, because the 録画一覧 is a space-level archive, not something
 * you do from where you stand (the RecordingsDock placement reasoning),
 * and the Worker never required presence either (現状同等).
 */
function recordingReadSetupIn(tx: Ctx, procedureName: string): CallConfig {
  requireApprovedMember(tx, procedureName);
  const cfg = callConfigOf(tx, procedureName);
  chargeCallAllowance(tx, procedureName);
  return cfg;
}

// The finished recordings in the R2 bucket, newest first (増分④→⑥ —
// 承認済みメンバー全員: the space's shared archive; the 増分⑤ reasoning
// for not narrowing to the starter or the participants stands).
export const listRecordings = spacetimedb.procedure(
  t.array(
    t.object('RecordingFileView', {
      fileName: t.string(),
      size: t.u64(),
      uploadedAt: t.string(),
    }),
  ),
  (ctx) => {
    const cfg = ctx.withTx((tx) => recordingReadSetupIn(tx, 'list_recordings'));
    const nowMs = Number(ctx.timestamp.microsSinceUnixEpoch / 1_000n);
    return listRecordingObjects(ctx.http, cfg, nowMs).map((object) => ({
      fileName: object.fileName,
      size: BigInt(object.size),
      uploadedAt: object.uploadedAt,
    }));
  },
);

// A short-lived presigned URL for one recording — the browser downloads
// straight from R2 (増分④→⑥). Pure signing, no external HTTP; the
// fileName is the one client-claimed value and is vetted to the provider
// naming, which also makes a key outside the recordings prefix
// unrepresentable (the shared shape rule).
export const recordingDownloadUrl = spacetimedb.procedure(
  { fileName: t.string() },
  t.string(),
  (ctx, { fileName }) => {
    if (!isRecordingFileNameLike(fileName)) {
      throw new SenderError('recording_download_url refused (invalid-file-name)');
    }
    const cfg = ctx.withTx((tx) => recordingReadSetupIn(tx, 'recording_download_url'));
    const nowMs = Number(ctx.timestamp.microsSinceUnixEpoch / 1_000n);
    return presignRecordingDownload(cfg, fileName, nowMs);
  },
);
