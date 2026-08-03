// fallow-ignore-file coverage-gaps -- reducers only run inside a SpacetimeDB module host, so no unit test can import this file; the rules worth testing (admission, replay, retention) are delegated to evaluateInputBatch / replayInputs / isExpiredRow in @maple/shared and unit-tested there
import {
  type AcceptedBatchVerdict,
  asMembership,
  type BatchRejectReason,
  CHAT_HISTORY_MAX,
  type ConnectionPolicy,
  chatOverflowIds,
  classifyConnection,
  DEFAULT_MAP,
  evaluateApplication,
  evaluateChatSend,
  evaluateInputBatch,
  evaluateJoin,
  evaluateMemberAction,
  evaluateReactionSend,
  evaluateRename,
  evaluateSettingChange,
  guestsAllowedFrom,
  initialMembership,
  isExpiredRow,
  isQuiescent,
  isReactionEmoji,
  type MemberAction,
  type Membership,
  normalizeChatText,
  profileNameFrom,
  replayInputs,
  resolveJoinName,
  type SendAllowanceVerdict,
  SPAWN_X,
  SPAWN_Y,
  stateFromRow,
} from '@maple/shared';
import { type InferSchema, type ReducerCtx, SenderError, t } from 'spacetimedb/server';
import { spacetimedb } from './tables';

/** The reducer context for this module's schema, for helpers that touch the db. */
type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;

/** The Identity type as this schema's rows carry it (not re-exported by the server SDK). */
type SenderIdentity = Ctx['sender'];

/**
 * The Clerk **development** instance. Its sign-up flow is open, so it must be
 * dropped from CONNECTION_POLICY.memberIssuers in the same change that adds the
 * production instance — otherwise anyone who signs up on the dev instance holds
 * a member token against production (ROADMAP Phase 1 lists this as a gate that
 * has to close before real users).
 */
const CLERK_DEVELOPMENT_ISSUER = 'https://famous-hornet-40.clerk.accounts.dev';

/**
 * SpacetimeDB validates any well-formed OIDC token's signature and derives an
 * Identity from issuer+subject, so deciding which issuers mean what is the
 * module's job — this policy is what "registering our issuer" amounts to.
 *
 * `guestIssuers` names the hosts whose own tokens we expect: a guest connects
 * tokenless, is handed a host-issued token, and replays it to resume its
 * per-tab identity. Both hosts we deploy to are registered — `localhost`
 * (standalone) and Maincloud (its issuer observed in production logs,
 * 2026-08-02) — so a token from any other issuer is refused outright
 * (classifyConnection's unregistered-issuer verdict; see onConnect).
 *
 * A new host must have its issuer added here before ANY guest can use it,
 * not merely before reconnects: the host stamps even a first, tokenless
 * connect with its own token before clientConnected runs (observed locally,
 * 2026-08-02 — with the host's issuer removed, fresh tokenless connects were
 * refused alongside replays), so a missing entry shuts every guest out.
 */
const CONNECTION_POLICY: ConnectionPolicy = {
  memberIssuers: [CLERK_DEVELOPMENT_ISSUER],
  memberAudience: 'kaede-spacetimedb',
  guestIssuers: ['localhost', 'https://auth.spacetimedb.com'],
};

/**
 * Guarantees a member has an account row, carrying the display name its
 * identity provider vouches for (the JWT `name` claim) as the initial
 * profile name — the Discord-model account exists, with a name, before any
 * membership application is filed. Only members get an account: a member's
 * Identity is stable across devices and reconnects (derived from the
 * provider's issuer+subject), so the row it maps to genuinely is the same
 * person; a guest Identity is per-tab and transient, and an account keyed by
 * it would be garbage the moment the tab closes.
 *
 * The claim only ever fills an empty name: a name the user chose is theirs,
 * and a later Google rename must not overwrite it. A missing claim (the
 * Clerk JWT template may not carry `name` yet — see ROADMAP) leaves the
 * profile nameless, exactly as before.
 *
 * find-then-insert is race-free here: reducers are atomic transactions that
 * the host serializes, so two first-time connections from the same member
 * (two tabs, two devices) cannot interleave — the second clientConnected
 * runs after the first committed and finds its row.
 */
function ensureAccount(ctx: Ctx): void {
  const claimedName = profileNameFrom(ctx.senderAuth.jwt?.fullPayload);
  const existing = ctx.db.account.identity.find(ctx.sender);
  if (existing === null) {
    ctx.db.account.insert({
      id: 0n, // 0 asks autoInc to assign the real id
      identity: ctx.sender,
      displayName: claimedName,
      createdAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
    });
    return;
  }
  backfillAccountName(ctx, existing.displayName, claimedName);
}

/**
 * Fills an account's empty display name from the provider's claim, if any —
 * through the same write path a rename takes (persistMemberName), so the
 * public space_member projection of a member who applied nameless picks the
 * name up too and cannot drift from the account. A separate function (not
 * inlined into ensureAccount) to keep the untestable reducer helpers under
 * the CRAP budget fallow enforces for uncovered functions.
 */
function backfillAccountName(
  ctx: Ctx,
  currentName: string | undefined,
  claimedName: string | undefined,
): void {
  if (currentName !== undefined || claimedName === undefined) return;
  persistMemberName(ctx, claimedName);
}

/** The sender-facing standing of an identity: its membership, or undefined for guests. */
function membershipOf(ctx: Ctx, identity: SenderIdentity): Membership | undefined {
  const row = ctx.db.spaceMember.identity.find(identity);
  return row === null ? undefined : asMembership(row);
}

/** The guest-admission setting, read with the shared missing-row default. */
function guestsAllowed(ctx: Ctx): boolean {
  return guestsAllowedFrom(ctx.db.spaceSetting.id.find(0));
}

/**
 * Vets every connection before it can act in the world. Which refusals
 * belong here and which in `join` follows one line: a refusal the user can
 * act on goes to `join` (an ordinary reducer error on an open connection,
 * mirrored client-side by decideAdmission over the subscribed rows), while a
 * refusal of the token itself must live here — the JWT is only readable
 * inside clientConnected, so `join` could not re-check it without a table
 * recording the verdict, and the client could not mirror it without that
 * state being public. Both token refusals (audience-mismatch,
 * unregistered-issuer) are configuration errors no user can fix, so the UX
 * a SenderError here produces — the socket closes and sync.ts retries with
 * backoff — is acceptable. What each refused client does then (observed
 * 2026-08-02): only the stored ANONYMOUS token has a fallback — a guest
 * replaying one against a correctly-configured host gives it up after
 * RESUME_MAX_FAILURES attempts (connection.ts) and recovers as a fresh
 * guest in ~30s. A signed-in client re-mints its OIDC token on every
 * attempt, so a member whose issuer the policy stops naming retries forever
 * until they sign out by hand — the skew to avoid when ROADMAP gate ①
 * swaps memberIssuers: deploy the client and module together. Likewise a
 * host whose own issuer is missing from guestIssuers refuses even fresh
 * tokenless guests (the host stamps them with its own token first), so
 * every guest retries forever — correct fail-fast for a deployment that is
 * broken for every guest. A refused browser sees only a generic socket
 * close (the host sends no close reason and the SDK discards the
 * CloseEvent — observed 2026-08-02), so diagnosis lives server-side: the
 * warn and the thrown SenderError both name the culprit issuer in the
 * module log (spacetimedb-cli logs / the Maincloud dashboard).
 */
export const onConnect = spacetimedb.clientConnected((ctx) => {
  const auth = classifyConnection(ctx.senderAuth.jwt, CONNECTION_POLICY);
  if (auth.kind === 'audience-mismatch') {
    throw new SenderError('Unauthorized: this token was minted for another application');
  }
  if (auth.kind === 'unregistered-issuer') {
    // The ROADMAP Phase 1 gate (closed 2026-08-02): a token nobody vouched
    // for used to be admitted with only this log line. World entry was never
    // at stake — join's evaluateJoin rules every guest either way — but the
    // admission granted connect-and-subscribe reads under a stable identity
    // no provider vouched for, a hole that widens with every privilege
    // guests gain. The issuer goes into the error message as well as this
    // warn so both module-log lines name the culprit (the refused browser
    // sees only a generic socket close — see the doc comment above).
    console.warn(`connection refused, unregistered issuer: ${auth.issuer}`);
    throw new SenderError(`Unauthorized: unregistered token issuer: ${auth.issuer}`);
  }
  if (auth.kind === 'member') {
    // The account (global profile) is a fact of signing in; the membership
    // is not — joining this space is an explicit application, filed by the
    // apply_for_membership reducer when the user asks to.
    ensureAccount(ctx);
    console.info(`member connected: sub=${auth.subject}`);
    return;
  }
  // Admission falls through to "let them in", so a verdict added later must not
  // land here silently. This costs no branch, unlike a fourth runtime case.
  auth satisfies { kind: 'guest' };
});

/**
 * Records why a batch was refused. `stale-tick` is the resend watchdog's normal
 * duplicate path, so it is not noteworthy. `gap-ahead-of-row` is logged: an
 * honest client only ever creates a gap from a fully-acked quiescent state
 * (evaluateSendWindow), so a moving-row gap means a lost batch raced the
 * send gate or someone is probing.
 */
function logRejection(
  reason: BatchRejectReason,
  sender: string,
  startTick: number,
  length: number,
  rowTick: number,
): void {
  if (reason === 'stale-tick') return;
  console.warn(
    `submit_inputs rejected (${reason}): sender=${sender} startTick=${startTick} len=${length} rowTick=${rowTick}`,
  );
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
 * reaction and reaction_guard rows ride along even though they are not
 * siblings (created lazily by send_chat_message / send_reaction, so a
 * player row need not have them): their owner may chat and react only
 * while in the world, so leaving the world is when they stop meaning
 * anything — and deleting them here is what keeps per-tab guest
 * identities from piling up rows forever (for the public `reaction`
 * table, rows that would ride every entering client's egress).
 */
function removePlayer(ctx: Ctx, identity: SenderIdentity): void {
  ctx.db.player.identity.delete(identity);
  ctx.db.playerName.identity.delete(identity);
  ctx.db.playerGuard.identity.delete(identity);
  ctx.db.chatGuard.identity.delete(identity);
  ctx.db.reaction.identity.delete(identity);
  ctx.db.reactionGuard.identity.delete(identity);
}

/** The player_name row as this schema returns it (not re-exported by the server SDK). */
type PlayerNameRow = NonNullable<ReturnType<Ctx['db']['playerName']['identity']['find']>>;

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
function spawnOrResume(ctx: Ctx): void {
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

/**
 * The sender's hot row and its name/guard siblings, or undefined when the
 * sender is not in the world — split out of the reducers that act on the
 * in-world sender (submitInputs, sendChatMessage) to keep those uncovered
 * arrows under the CRAP budget fallow enforces (the backfillAccountName
 * precedent). A row missing either sibling cannot happen through this
 * module's write paths (the lifecycle functions above), but if one ever
 * appears (manual sql, a future bug) it is reclaimed rather than tolerated
 * — the transitionMember precedent that an "unreachable" branch must not
 * read as a silent no-op. A missing guard would otherwise silence the
 * sender's inputs forever with nothing to repair it; a missing name would
 * otherwise persist too, since only this check sees the resume path (a
 * client resuming its surviving row never calls join, so the sibling
 * upsert there cannot heal it) and set_display_name refuses rather than
 * adopts a nameless player. The owner sees its row deleted and re-joins,
 * recreating all three siblings.
 */
function findWorldRows(ctx: Ctx) {
  const row = ctx.db.player.identity.find(ctx.sender);
  if (!row) return undefined;
  const guard = ctx.db.playerGuard.identity.find(ctx.sender);
  const nameRow = ctx.db.playerName.identity.find(ctx.sender);
  if (guard && nameRow) return { row, guard, nameRow };
  console.warn(`player row missing a sibling, reclaiming: sender=${ctx.sender.toHexString()}`);
  removePlayer(ctx, ctx.sender);
  return undefined;
}

/**
 * The sender's world rows if the admission rules would still admit it, or
 * undefined — the shared preamble of every reducer that acts as "someone in
 * the world" (submitInputs, sendChatMessage). Admission applies to acting,
 * not just to joining: a player row whose owner the rules would now refuse
 * (possible only as a leftover from before the rules — e.g. a re-publish
 * onto a database with pre-admission rows, since every status change
 * deletes the row transactionally) must not keep driving movement or
 * speaking, so it is reclaimed rather than obeyed.
 *
 * Callers must treat undefined as "refused, and any reclaim is already
 * done" and RETURN, never throw: reducers are atomic, so a thrown
 * SenderError would roll back the very reclaim this function performed
 * (both the admission reclaim here and findWorldRows' broken-pair one).
 */
function findAdmittedWorldRows(ctx: Ctx) {
  const found = findWorldRows(ctx);
  if (!found) return undefined;
  const admission = evaluateJoin({
    membership: membershipOf(ctx, ctx.sender),
    guestsAllowed: guestsAllowed(ctx),
  });
  if (admission.ok) return found;
  removePlayer(ctx, ctx.sender);
  return undefined;
}

/**
 * Identities holding a name, guard or reaction row whose player row is gone.
 * `reaction` is enumerated alongside the join siblings because it is public:
 * an orphaned reaction row would ride every entering client's egress, where
 * the private lazy guards (chat_guard, reaction_guard) merely sit as junk —
 * removePlayer deletes those too once an orphan is found by any table here.
 */
function orphanedSiblingIdentities(ctx: Ctx): SenderIdentity[] {
  const orphans = [];
  for (const row of [
    ...ctx.db.playerName.iter(),
    ...ctx.db.playerGuard.iter(),
    ...ctx.db.reaction.iter(),
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
function sweepOrphanedSiblings(ctx: Ctx): void {
  for (const identity of orphanedSiblingIdentities(ctx)) removePlayer(ctx, identity);
}
// ── End player lifecycle ────────────────────────────────────────────────

// Server-authoritative movement: clients send only inputs, the server replays
// them through the same shared physics. Position cannot change any other way.
// Admission (batch size, gap/ordering, token-bucket rate limit, heartbeat
// classification) lives in the pure evaluateInputBatch so it is unit-tested
// in @maple/shared. Two idle-suppression cases ride on this one reducer so
// no new reducer (= no bindings regeneration) is needed (ROADMAP Phase 2):
// - An EMPTY batch is a heartbeat: a quiescent client sends no input ticks
//   at all, so this is how its row's updatedAt keeps moving and the
//   retention sweep (isExpiredRow) knows it is still alive.
// - startTick may run PAST row.tick when the row is quiescent: the gap is
//   the empty ticks the sender's send gate skipped, provably no-ops, so the
//   tick counter fast-forwards to startTick without replaying them.
export const submitInputs = spacetimedb.reducer(
  { startTick: t.u32(), inputs: t.array(t.u8()) },
  (ctx, { startTick, inputs }) => {
    // Not in the world, or no longer admitted (findAdmittedWorldRows
    // reclaims the row in that case): silently drop the batch.
    const found = findAdmittedWorldRows(ctx);
    if (!found) return;
    const { row, guard } = found;

    const verdict = evaluateInputBatch({
      batchLength: inputs.length,
      startTick,
      rowTick: row.tick,
      rowQuiescent: isQuiescent(stateFromRow(row)),
      rowAgeMs: ctx.timestamp.since(row.updatedAt).millis,
      rowOnline: row.online,
      allowanceMicros: guard.allowanceMicros,
      nowMicros: ctx.timestamp.microsSinceUnixEpoch,
    });
    if (verdict.kind === 'rejected') {
      logRejection(verdict.reason, ctx.sender.toHexString(), startTick, inputs.length, row.tick);
      return;
    }

    applyAcceptedBatch(ctx, found, startTick, inputs, verdict);
  },
);

/** The rows the in-world reducers act on, as findWorldRows returns them. */
type WorldRows = NonNullable<ReturnType<typeof findWorldRows>>;

/**
 * Applies an accepted submit_inputs verdict — a heartbeat's liveness refresh,
 * or a replayed input batch. Split out of the reducer to keep that uncovered
 * arrow under the CRAP budget fallow enforces (the backfillAccountName
 * precedent); the decisions themselves live in evaluateInputBatch,
 * unit-tested in @maple/shared.
 */
function applyAcceptedBatch(
  ctx: Ctx,
  rows: WorldRows,
  startTick: number,
  inputs: number[],
  verdict: AcceptedBatchVerdict,
): void {
  const { row, guard } = rows;
  if (verdict.kind === 'heartbeat') {
    // Liveness only: no replay, no guard update. `refresh` covers both the
    // periodic keep-alive (only once the row has aged past
    // HEARTBEAT_MIN_AGE_MS, bounding how often spam could rewrite the row —
    // = egress to every subscriber) and the reconnect announcement that
    // flips an offline resumed row back to visible.
    if (verdict.refresh) {
      ctx.db.player.identity.update({ ...row, online: true, updatedAt: ctx.timestamp });
    }
    return;
  }

  const s = replayInputs(stateFromRow(row), inputs, DEFAULT_MAP);

  ctx.db.playerGuard.identity.update({ ...guard, allowanceMicros: verdict.allowanceMicros });
  ctx.db.player.identity.update({
    ...row,
    x: s.x,
    y: s.y,
    vx: s.vx,
    vy: s.vy,
    facing: s.facing,
    onGround: s.onGround,
    rope: s.rope,
    // startTick, not row.tick: an accepted quiescent gap fast-forwards the
    // counter over the elided empty ticks (startTick === row.tick when
    // there is no gap).
    tick: startTick + inputs.length,
    online: true, // a stale disconnect event may have raced us; inputs prove liveness
    updatedAt: ctx.timestamp,
  });
}

/**
 * Deletes rows whose retention window has elapsed, whatever they are flagged
 * as: see isExpiredRow for why age rather than `online` decides. Identities are
 * collected first so nothing is removed out from under the iterator.
 *
 * A client throttled long enough to be swept while still connected notices the
 * delete of its own row and re-joins, so reclaiming a row is recoverable.
 */
function sweepExpiredRows(ctx: Ctx): void {
  const stale = [];
  for (const row of ctx.db.player.iter()) {
    if (isExpiredRow(ctx.timestamp.since(row.updatedAt).millis)) {
      stale.push(row.identity);
    }
  }
  for (const identity of stale) removePlayer(ctx, identity);
}

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

/**
 * Persists a member's name on its account (the source of truth) and mirrors
 * it onto the public space_member projection, so the admin UI and the
 * waiting room show the same name the next join will spawn under.
 */
function persistMemberName(ctx: Ctx, name: string): void {
  const account = ctx.db.account.identity.find(ctx.sender);
  if (account !== null) {
    ctx.db.account.id.update({ ...account, displayName: name, updatedAt: ctx.timestamp });
  }
  const member = ctx.db.spaceMember.identity.find(ctx.sender);
  if (member !== null) {
    ctx.db.spaceMember.identity.update({ ...member, displayName: name, updatedAt: ctx.timestamp });
  }
}

// Renames the sender everywhere it is visible right now (its player_name
// row — the label every client renders) and, for members, persists the name
// on the account so every future join — any device, any reconnect — spawns
// under it. Guests have no account, so their rename lives only as long as
// their per-tab identity's player rows.
// Admission (name validation, refusing a rename with nowhere to land) is the
// pure evaluateRename, unit-tested in @maple/shared — the same rules the
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

// ── Chat ────────────────────────────────────────────────────────────────

/**
 * The shared preamble of every posting reducer (send_chat_message /
 * send_reaction): the sender's world rows, or undefined after a refusal.
 * Splits the two refusal cases along the loud/silent rule documented on
 * sendChatMessage — no player row at all is loud (thrown before anything
 * can write), while findAdmittedWorldRows returning undefined DESPITE the
 * row existing means a reclaim just happened and must commit, so that
 * refusal stays a logged return.
 */
function findPostingSender(ctx: Ctx, reducerName: string): WorldRows | undefined {
  if (ctx.db.player.identity.find(ctx.sender) === null) {
    throw new SenderError(`${reducerName} refused (not-in-world)`);
  }
  const found = findAdmittedWorldRows(ctx);
  if (!found) {
    console.warn(`${reducerName} dropped (reclaimed): sender=${ctx.sender.toHexString()}`);
  }
  return found;
}

/** A send-rate token-bucket marker table (identity → allowanceMicros). */
type SendGuardTable = Ctx['db']['chatGuard'] | Ctx['db']['reactionGuard'];

/** A send-rate guard row, as either marker table returns it. */
type SendGuardRow = NonNullable<ReturnType<SendGuardTable['identity']['find']>>;

/**
 * Charges one send against the sender's token bucket on `guardTable`, or
 * refuses the send (乱用対策 — the Phase 0 input guard's thinking applied
 * to chat and reactions). The rule itself is the pure `evaluate`
 * (evaluateChatSend / evaluateReactionSend, unit-tested in @maple/shared);
 * a missing guard row reads as the epoch marker, which the bucket's bank
 * cap turns into exactly one full burst. The marker write-back is split
 * into writeSendAllowance to keep these uncovered arrows under the CRAP
 * budget fallow enforces (the backfillAccountName precedent).
 */
function chargeSendAllowance(
  ctx: Ctx,
  guardTable: SendGuardTable,
  evaluate: (request: { allowanceMicros: bigint; nowMicros: bigint }) => SendAllowanceVerdict,
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

/**
 * Deletes the oldest messages beyond the retention cap (保持方針 — see the
 * chat_message table comment for why row count is the budget that matters).
 * Runs after every accepted send, so the table can only ever exceed
 * CHAT_HISTORY_MAX by the one row just inserted and the enumeration stays
 * cheap.
 */
function trimChatHistory(ctx: Ctx): void {
  const ids = [...ctx.db.chatMessage.iter()].map((row) => row.id);
  for (const id of chatOverflowIds(ids, CHAT_HISTORY_MAX)) {
    ctx.db.chatMessage.id.delete(id);
  }
}

// Posts one message to the global-scope chat (ROADMAP Phase 2 第一弾).
//
// Chat eligibility IS presence in the world: only join (which enforces
// admission) creates a player row, so a waiting-room member, a connection
// that never entered, or a kicked guest has no row and is refused — and a
// guests-off flip silences the guests it kicks in the same transaction
// that removes them.
//
// Which refusals are loud follows one line — a SenderError is safe exactly
// while nothing has been written (reducers are atomic, so a throw rolls
// every prior write back):
// - No player row at all (the common refusal; checked before anything can
//   write): loud, so the sender's client hears it (NetHooks.onChatRefused)
//   instead of the message silently evaporating.
// - findAdmittedWorldRows returned undefined DESPITE the row existing: a
//   reclaim just happened (lost admission, or a broken sibling pair) and
//   must commit, so this refusal stays silent — the sender still gets
//   feedback, because deleting its player row reaches it as a row event
//   and flips its UI to the admission notice.
// - A bad message or the rate limit: loud; they throw before any write.
// Validation and the rate rule are pure functions in @maple/shared, shared
// with the client so its input-side feedback can never disagree with the
// authority here. The sender's display name is snapshotted onto the row —
// see the chat_message table comment for why identity lookups cannot
// outlive the player rows.
//
// Guests may chat whenever they may be in the world — deliberately not a
// separate setting (ゲストに許可する行動範囲): a guest someone let into the
// room and then cannot talk to defeats the oVice-style ease guest entry
// exists for, and the guests_allowed toggle already gives admins the
// "no guests right now" lever, which cuts chat with the same flip. A
// per-capability setting (chat / DM / reactions) can land later as
// additive space_setting columns with defaults.
export const sendChatMessage = spacetimedb.reducer({ text: t.string() }, (ctx, { text }) => {
  const found = findPostingSender(ctx, 'send_chat_message');
  if (!found) return;
  const verdict = normalizeChatText(text);
  if (!verdict.ok) throw new SenderError(`send_chat_message refused (${verdict.reason})`);
  chargeSendAllowance(ctx, ctx.db.chatGuard, evaluateChatSend, 'send_chat_message');
  ctx.db.chatMessage.insert({
    id: 0n, // 0 asks autoInc to assign the real id
    sender: ctx.sender,
    senderName: found.nameRow.name,
    text: verdict.text,
    sentAt: ctx.timestamp,
  });
  trimChatHistory(ctx);
});

/** Writes the sender's reaction: the upsert row (see the `reaction` table). */
function upsertReaction(ctx: Ctx, emoji: string): void {
  const row = { identity: ctx.sender, emoji, sentAt: ctx.timestamp };
  if (ctx.db.reaction.identity.find(ctx.sender)) ctx.db.reaction.identity.update(row);
  else ctx.db.reaction.insert(row);
}

// Posts one emoji reaction, shown transiently above the sender's avatar
// (ROADMAP Phase 2). Eligibility is exactly send_chat_message's: presence
// in the world (only join creates a player row) plus the admission
// re-check, so guests may react whenever they may be in the world — the
// same deliberate non-setting as chat (see sendChatMessage's closing
// comment), and the guests_allowed flip silences reactions with the same
// transaction that kicks the guests. Which refusals are loud follows
// sendChatMessage's rule verbatim: no player row, a non-palette emoji and
// the rate limit all throw before any write; the reclaim path stays
// silent because its row deletion must commit.
//
// The emoji is validated by exact match against the shared palette
// (isReactionEmoji) — free-form strings never reach the public table, so
// no text normalization questions apply. Unlike chat there is no
// client-side bucket mirror and no refusal notice: a reaction is a
// transient gesture, so a burst-exceeding click simply not appearing is
// feedback enough (an accepted simplification; the server refusal above
// stays loud for the reducer log).
export const sendReaction = spacetimedb.reducer({ emoji: t.string() }, (ctx, { emoji }) => {
  if (!findPostingSender(ctx, 'send_reaction')) return;
  if (!isReactionEmoji(emoji)) {
    throw new SenderError('send_reaction refused (unknown-emoji)');
  }
  chargeSendAllowance(ctx, ctx.db.reactionGuard, evaluateReactionSend, 'send_reaction');
  upsertReaction(ctx, emoji);
});
// ── End chat ────────────────────────────────────────────────────────────

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
 * (unit-tested in @maple/shared); the account is never touched, so no
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
// MemberAction and evaluateMemberAction in @maple/shared). An approved
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
  const verdict = evaluateSettingChange({ actor: membershipOf(ctx, ctx.sender) });
  if (!verdict.ok) {
    throw new SenderError(`set_guests_allowed refused (${verdict.reason})`);
  }
  upsertGuestsAllowed(ctx, allowed);
  if (!allowed) sweepGuestPlayers(ctx);
});

// Keep the row on disconnect (marked offline) so a quick reconnect under the
// same identity resumes the character; join sweeps rows past their retention.
export const onDisconnect = spacetimedb.clientDisconnected((ctx) => {
  const row = ctx.db.player.identity.find(ctx.sender);
  if (!row) return;
  ctx.db.player.identity.update({ ...row, online: false, updatedAt: ctx.timestamp });
});
