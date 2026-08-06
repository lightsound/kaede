// fallow-ignore-file coverage-gaps -- reducers only run inside a SpacetimeDB module host, so no unit test can import this file; the rules worth testing (admission, replay, retention) are delegated to evaluateInputBatch / replayInputs / isExpiredRow in @kaede/shared and unit-tested there
import {
  type AcceptedBatchVerdict,
  asMembership,
  type BatchRejectReason,
  CONNECTION_EVENT_MAX,
  type ConnectionPolicy,
  classifyConnection,
  DISCONNECT_INTENT_FRESH_MS,
  disconnectReasonFrom,
  evaluateApplication,
  evaluateInputBatch,
  evaluateJoin,
  evaluateMemberAction,
  evaluatePortalSend,
  evaluatePortalUse,
  evaluateRename,
  initialMembership,
  isQuiescent,
  type MemberAction,
  type Membership,
  mapFor,
  memberIssuersFor,
  profileNameFrom,
  replayInputs,
  stateFromRow,
} from '@kaede/shared';
import { SenderError, t } from 'spacetimedb/server';
import { spacetimedb } from './tables';
import {
  type Ctx,
  chargeSendAllowance,
  findAdmittedWorldRows,
  guestsAllowed,
  membershipOf,
  removePlayer,
  requireAdmin,
  type SenderIdentity,
  spawnOrResume,
  sweepExpiredRows,
  sweepOrphanedSiblings,
  syncGroupOccupancy,
  syncNameOnline,
  trimHistory,
  type WorldRows,
} from './world';

/**
 * The Clerk **production** instance (kaede.town). The issuer is derived from
 * the domain, and every real member's Identity is derived from this issuer —
 * once anyone has signed in against it, changing it means migrating every
 * account's Identity, so treat it as immutable (VISION 名前・ドメイン).
 */
const CLERK_PRODUCTION_ISSUER = 'https://clerk.kaede.town';

/**
 * The Clerk **development** instance. Its sign-up flow is open, so the
 * production database must never accept it as a member issuer — anyone who
 * signed up on the dev instance would hold a member token against
 * production: they could queue in the application list, and on an empty
 * database they could seed themselves as the very first admin (ROADMAP
 * Phase 1 gate ①). It STAYS a member issuer on every other database so
 * local development keeps signing in with the pk_test_ keys; the split is
 * memberIssuersFor, keyed on the database's own identity in
 * connectionPolicyFor below.
 */
const CLERK_DEVELOPMENT_ISSUER = 'https://accepted-toucan-79.clerk.accounts.dev';

/**
 * The production database: Maincloud `kaede` (`spacetime list` /
 * the Maincloud dashboard; renamed from `maple-like` 2026-08-04 — a rename
 * keeps the identity, so this pin survived it). The database's own identity is the
 * only production marker a reducer can see — it cannot ask which host it
 * runs on, while `ctx.databaseIdentity` is stable for the database's
 * lifetime (re-publishes keep it; only delete-and-recreate mints a new
 * one).
 *
 * ⚠️ A stale value fails OPEN: if the production database is ever
 * recreated (the docs/backup-restore.md runbook), its new identity no
 * longer matches, the module assumes non-production and re-admits the
 * development issuer as a member mint. Update this constant in the same
 * deploy that recreates the database. The tripwire for a silent miss is
 * the console.warn in onConnect — a dev-issuer member connect on
 * production shows up in the Maincloud module log.
 */
const PRODUCTION_DATABASE_IDENTITY =
  'c200fd9e16f8d33914950b193af4ac48b398f115db831634b86c6dc5f11b23c3';

/**
 * SpacetimeDB validates any well-formed OIDC token's signature and derives an
 * Identity from issuer+subject, so deciding which issuers mean what is the
 * module's job — this policy is what "registering our issuer" amounts to.
 * `memberIssuers` depends on which database the module woke up in (gate ① —
 * see memberIssuersFor and the constants above), so the policy is built per
 * connection rather than once at module load; the ctx is not available
 * earlier, and the two-entry array cost is nothing next to a connect.
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
function connectionPolicyFor(ctx: Ctx): ConnectionPolicy {
  return {
    memberIssuers: memberIssuersFor(
      ctx.databaseIdentity.toHexString() === PRODUCTION_DATABASE_IDENTITY,
      { production: CLERK_PRODUCTION_ISSUER, development: CLERK_DEVELOPMENT_ISSUER },
    ),
    memberAudience: 'kaede-spacetimedb',
    guestIssuers: ['localhost', 'https://auth.spacetimedb.com'],
  };
}

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
function ensureAccount(ctx: Ctx, subject: string): void {
  const claimedName = profileNameFrom(ctx.senderAuth.jwt?.fullPayload);
  const existing = ctx.db.account.identity.find(ctx.sender);
  if (existing === null) {
    ctx.db.account.insert({
      id: 0n, // 0 asks autoInc to assign the real id
      identity: ctx.sender,
      displayName: claimedName,
      createdAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
      subject,
    });
    return;
  }
  backfillAccountName(ctx, existing.displayName, claimedName);
  backfillAccountSubject(ctx, subject);
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

/**
 * Records the provider subject on the sender's account row (see the
 * `subject` column comment in tables.ts): fills rows that predate the
 * column, and rewrites it if a re-link ever changes the identity's
 * provider mapping. Re-read rather than passed through because
 * backfillAccountName may have just rewritten the row (persistMemberName)
 * and a stale copy would clobber it. A separate function to keep
 * ensureAccount under the CRAP budget (the backfillAccountName
 * precedent).
 */
function backfillAccountSubject(ctx: Ctx, subject: string): void {
  const account = ctx.db.account.identity.find(ctx.sender);
  if (account === null || account.subject === subject) return;
  ctx.db.account.id.update({ ...account, subject, updatedAt: ctx.timestamp });
}

/**
 * The tripwire for a stale PRODUCTION_DATABASE_IDENTITY (see its comment):
 * a dev-issuer member mint is business as usual on a local database but
 * must never appear in the production module log — if this warn shows up
 * there, the identity pin has gone stale and gate ① has silently reopened.
 * The member verdict does not carry the issuer, so it is re-read from the
 * claims (non-null on every member connection by definition). A separate
 * function (not inlined into onConnect) to keep the untestable reducer
 * under the CRAP budget fallow enforces — the backfillAccountName
 * precedent.
 */
function warnDevIssuerMint(ctx: Ctx): void {
  if (ctx.senderAuth.jwt?.issuer !== CLERK_DEVELOPMENT_ISSUER) return;
  console.warn(
    `member minted by the DEVELOPMENT issuer (database ${ctx.databaseIdentity.toHexString()} presumed non-production — gate ①)`,
  );
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
  const auth = classifyConnection(ctx.senderAuth.jwt, connectionPolicyFor(ctx));
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
    warnDevIssuerMint(ctx);
    // The account (global profile) is a fact of signing in; the membership
    // is not — joining this space is an explicit application, filed by the
    // apply_for_membership reducer when the user asks to.
    ensureAccount(ctx, auth.subject);
    console.info(`member connected: sub=${auth.subject}`);
    recordConnectionEvent(ctx, 'connected', 'member');
    return;
  }
  // Admission falls through to "let them in", so a verdict added later must not
  // land here silently. This costs no branch, unlike a fourth runtime case.
  auth satisfies { kind: 'guest' };
  recordConnectionEvent(ctx, 'connected', 'guest');
});

/**
 * Appends one row to the private connection-event log and trims it to its
 * cap (see the connection_event table comment for why the log lives
 * server-side and stays private). Refused connections never reach this:
 * both token refusals in onConnect throw, and a reducer throw rolls every
 * write back — the module log already names those. A missing connectionId
 * cannot happen on the connect/disconnect lifecycle handlers, but the field
 * is nullable on the reducer context type; an uncorrelatable event row
 * would poison the pairing SQL, so it is skipped with a log rather than
 * invented.
 */
function recordConnectionEvent(ctx: Ctx, kind: 'connected' | 'disconnected', detail: string): void {
  if (ctx.connectionId === null) {
    console.warn(`connection event without a connectionId, skipped: ${kind} (${detail})`);
    return;
  }
  ctx.db.connectionEvent.insert({
    id: 0n, // 0 asks autoInc to assign the real id
    identity: ctx.sender,
    connectionId: ctx.connectionId,
    kind,
    detail,
    at: ctx.timestamp,
  });
  trimHistory(ctx.db.connectionEvent, CONNECTION_EVENT_MAX);
}

// Announces that this CONNECTION is about to cut itself deliberately — the
// idle guard's suspension after IDLE_DISCONNECT_MS without input (the
// client's net.package/idle.ts), sent right before it closes the socket so
// clientDisconnected can label the drop 'idle' instead of 'unannounced'
// (disconnectReasonFrom in @kaede/shared; see the disconnect_intent table
// comment). Delivery rides the WebSocket close contract: data queued before
// close() is flushed first, so no ack round-trip is needed. Keyed by
// connectionId, so a member's second tab cannot relabel the first tab's
// drop. No rate guard: the write is a single private upsert row per
// connection (nothing to broadcast), which is cheaper than the already
// unguarded refusal paths, and lying here only mislabels the liar's own row.
export const announceIdleSuspend = spacetimedb.reducer((ctx) => {
  if (ctx.connectionId === null) return;
  const existing = ctx.db.disconnectIntent.connectionId.find(ctx.connectionId);
  if (existing) {
    ctx.db.disconnectIntent.connectionId.update({ ...existing, announcedAt: ctx.timestamp });
    return;
  }
  ctx.db.disconnectIntent.insert({ connectionId: ctx.connectionId, announcedAt: ctx.timestamp });
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

// Server-authoritative movement: clients send only inputs, the server replays
// them through the same shared physics. Position cannot change any other way.
// Admission (batch size, gap/ordering, token-bucket rate limit, heartbeat
// classification) lives in the pure evaluateInputBatch so it is unit-tested
// in @kaede/shared. Two idle-suppression cases ride on this one reducer so
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
    // reclaims the row in that case): silently drop the batch — movement
    // needs no loud refusal, so both verdict reasons read the same here.
    const found = findAdmittedWorldRows(ctx);
    if (!found.ok) return;
    const { row, guard } = found.rows;

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

    applyAcceptedBatch(ctx, found.rows, startTick, inputs, verdict);
  },
);

/**
 * Applies an accepted submit_inputs verdict — a heartbeat's liveness refresh,
 * or a replayed input batch. Split out of the reducer to keep that uncovered
 * arrow under the CRAP budget fallow enforces (the backfillAccountName
 * precedent); the decisions themselves live in evaluateInputBatch,
 * unit-tested in @kaede/shared.
 */
function applyAcceptedBatch(
  ctx: Ctx,
  rows: WorldRows,
  startTick: number,
  inputs: number[],
  verdict: AcceptedBatchVerdict,
): void {
  const { row, guard, nameRow } = rows;
  if (verdict.kind === 'heartbeat') {
    // Liveness only: no replay, no guard update. `refresh` covers both the
    // periodic keep-alive (only once the row has aged past
    // HEARTBEAT_MIN_AGE_MS, bounding how often spam could rewrite the row —
    // = egress to every subscriber) and the reconnect announcement that
    // flips an offline resumed row back to visible.
    if (verdict.refresh) {
      ctx.db.player.identity.update({ ...row, online: true, updatedAt: ctx.timestamp });
      syncNameOnline(ctx, nameRow, true);
    }
    return;
  }

  // The replay runs on the map the row is on: enter_portal is the only map
  // transition, so a batch never crosses maps mid-replay.
  const s = replayInputs(stateFromRow(row), inputs, mapFor(row.mapId).collision);

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
  syncNameOnline(ctx, nameRow, true);
  // Group occupancy follows the authoritative position (ROADMAP Phase 3
  // 増分②③ — the server-side judgment; see zone.ts in @kaede/shared for
  // why not the portal pattern). The heartbeat branch above skips it: no
  // movement, no transition to rule on.
  syncGroupOccupancy(ctx, ctx.sender, { x: s.x, y: s.y }, row.mapId);
}

// Teleports the sender through a portal it is standing in (ROADMAP Phase 3
// ポータル移動): the one write path that changes a player's mapId. The
// client flushes its pending inputs before calling (sync.ts), so the
// deterministic replay has already put the row exactly where the sender's
// prediction stood and evaluatePortalUse (pure, unit-tested in
// @kaede/shared) re-checks the same geometry the client's intent detection
// used — no position slack, no trust in the client's resolution. The
// landing pose is standing-still at the target (a quiescent fixpoint,
// fixed by the shared map unit tests), so the traveler's send gate can go
// silent immediately.
//
// `tick` advances by ONE even though a teleport applies no inputs: it is
// the fence that invalidates in-flight input batches. The client keeps
// ticking on the ORIGIN map until the teleported row round-trips back
// (its prediction is torn down only then — sync.ts switchMap), so a flush
// cadence can land origin-map inputs here after the teleport; with the
// old tick they replayed from the landing spot on the DESTINATION map
// (walking the traveler around a map its inputs never saw), while a
// bumped tick makes every batch minted against the pre-teleport counter
// refuse as stale-tick — the resend watchdog's silent duplicate path, no
// log noise. The client's fresh prediction starts from this row's tick,
// so it is never out of step.
//
// Refusals follow the movement rule (silent drop + warn) rather than
// chat's loud SenderError: a stale double-press racing the first teleport
// is the common refusal, and honest clients cannot act on the error
// anyway. The rate charge (portal_guard) still throws — nothing is
// written before it, and a rate-limited spammer deserves the log line.
export const enterPortal = spacetimedb.reducer({ portalId: t.u32() }, (ctx, { portalId }) => {
  const found = findAdmittedWorldRows(ctx);
  if (!found.ok) return;
  const { row, nameRow } = found.rows;
  const verdict = evaluatePortalUse({
    state: stateFromRow(row),
    portalId,
    map: mapFor(row.mapId),
  });
  if (!verdict.ok) {
    console.warn(
      `enter_portal rejected (${verdict.reason}): sender=${ctx.sender.toHexString()} mapId=${row.mapId} portalId=${portalId}`,
    );
    return;
  }
  chargeSendAllowance(ctx, ctx.db.portalGuard, evaluatePortalSend, 'enter_portal');
  ctx.db.player.identity.update({
    ...row,
    mapId: verdict.target.mapId,
    x: verdict.target.x,
    y: verdict.target.y,
    vx: 0,
    vy: 0,
    onGround: true,
    rope: -1,
    tick: row.tick + 1, // the in-flight-batch fence — see the doc comment
    online: true, // using a portal proves liveness (the accepted-batch rule)
    updatedAt: ctx.timestamp,
  });
  syncNameOnline(ctx, nameRow, true);
  // A teleport moves the authoritative position like any movement: the
  // occupancy pass leaves the origin map's zone — or huddle: a huddle
  // lives on its founding map, so teleporting off it is leaving
  // (keepsHuddleMembership) — and rules on the landing spot (an admin may
  // well place a zone over a portal mouth).
  syncGroupOccupancy(ctx, ctx.sender, verdict.target, verdict.target.mapId);
});

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

/**
 * Consumes the sender connection's announce (if any) and logs the disconnect
 * with its classification. The intent row is deleted whether or not it was
 * fresh — its connection is gone either way — and the sweep below clears
 * intents whose disconnect never fired (a crashed host mid-close, a bug),
 * so a stale row can neither linger forever nor mislabel anything: by the
 * time it could, disconnectReasonFrom has already aged it out.
 */
function recordDisconnect(ctx: Ctx): void {
  const intent =
    ctx.connectionId === null ? null : ctx.db.disconnectIntent.connectionId.find(ctx.connectionId);
  const reason = disconnectReasonFrom(
    intent === null ? undefined : ctx.timestamp.since(intent.announcedAt).millis,
  );
  if (intent !== null) ctx.db.disconnectIntent.connectionId.delete(intent.connectionId);
  recordConnectionEvent(ctx, 'disconnected', reason);
  sweepStaleIntents(ctx);
}

/**
 * Deletes intent rows past their freshness window (identities collected
 * first — the sweepExpiredRows precedent). Piggybacked on every disconnect
 * rather than scheduled: the table normally holds zero-to-few rows, and a
 * space with no disconnects accumulates no intents to sweep.
 */
function sweepStaleIntents(ctx: Ctx): void {
  const stale = [];
  for (const row of ctx.db.disconnectIntent.iter()) {
    if (ctx.timestamp.since(row.announcedAt).millis > DISCONNECT_INTENT_FRESH_MS) {
      stale.push(row.connectionId);
    }
  }
  for (const connectionId of stale) ctx.db.disconnectIntent.connectionId.delete(connectionId);
}

// Keep the row on disconnect (marked offline) so a quick reconnect under the
// same identity resumes the character; join sweeps rows past their retention.
export const onDisconnect = spacetimedb.clientDisconnected((ctx) => {
  recordDisconnect(ctx);
  const row = ctx.db.player.identity.find(ctx.sender);
  if (!row) return;
  ctx.db.player.identity.update({ ...row, online: false, updatedAt: ctx.timestamp });
  // Mirror onto the presence directory (see player_name in tables.ts). The
  // name row is the player row's sibling by construction; a broken pair is
  // reclaimed on the next act, so a missing row here is just skipped.
  const nameRow = ctx.db.playerName.identity.find(ctx.sender);
  if (nameRow) syncNameOnline(ctx, nameRow, false);
});
