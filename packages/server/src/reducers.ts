// fallow-ignore-file coverage-gaps -- reducers only run inside a SpacetimeDB module host, so no unit test can import this file; the rules worth testing (admission, replay, retention) are delegated to evaluateInputBatch / replayInputs / isExpiredRow in @maple/shared and unit-tested there
import {
  asMembership,
  type BatchRejectReason,
  type ConnectionPolicy,
  classifyConnection,
  DEFAULT_MAP,
  evaluateApplication,
  evaluateInputBatch,
  evaluateJoin,
  evaluateMemberAction,
  evaluateRename,
  evaluateSettingChange,
  guestsAllowedFrom,
  initialMembership,
  isExpiredRow,
  type MemberAction,
  type Membership,
  profileNameFrom,
  replayInputs,
  resolveJoinName,
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
 * duplicate path, so it is not noteworthy.
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
// path, removePlayer the only delete path, and findMovementRows /
// sweepOrphanedSiblings reclaim a broken pair from either direction
// instead of acting on it.

/**
 * Removes one player from the world: the hot row and its name/guard
 * siblings, in the same transaction. The single delete path — every
 * reclaim (sweep, guest kick, status change, stale-row and broken-pair
 * reclaim) goes through here, which is what keeps the three player_*
 * tables paired (a player row always has its siblings).
 */
function removePlayer(ctx: Ctx, identity: SenderIdentity): void {
  ctx.db.player.identity.delete(identity);
  ctx.db.playerName.identity.delete(identity);
  ctx.db.playerGuard.identity.delete(identity);
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
 * The sender's hot row and its guard sibling, or undefined when the sender
 * is not in the world — split out of submitInputs to keep that uncovered
 * reducer under the CRAP budget fallow enforces (the backfillAccountName
 * precedent). A row without its guard cannot happen through this module's
 * write paths (the lifecycle functions above), but if one ever appears
 * (manual sql, a future bug) it is reclaimed rather than tolerated: an
 * undefined here silences the sender's inputs, so leaving the broken pair
 * in place would drop them forever with nothing to repair it — the
 * transitionMember precedent that an "unreachable" branch must not read as
 * a silent no-op. The owner sees its row deleted and re-joins, recreating
 * all three siblings.
 */
function findMovementRows(ctx: Ctx) {
  const row = ctx.db.player.identity.find(ctx.sender);
  if (!row) return undefined;
  const guard = ctx.db.playerGuard.identity.find(ctx.sender);
  if (guard) return { row, guard };
  console.warn(
    `player row without its guard sibling, reclaiming: sender=${ctx.sender.toHexString()}`,
  );
  removePlayer(ctx, ctx.sender);
  return undefined;
}

/** Identities holding a name or guard row whose player row is gone. */
function orphanedSiblingIdentities(ctx: Ctx): SenderIdentity[] {
  const orphans = [];
  for (const row of [...ctx.db.playerName.iter(), ...ctx.db.playerGuard.iter()]) {
    if (ctx.db.player.identity.find(row.identity) === null) orphans.push(row.identity);
  }
  return orphans;
}

/**
 * Reclaims sibling rows whose player row was deleted out from under them —
 * the mirror image of findMovementRows' broken-pair reclaim, needed because
 * both expiry sweeps iterate only `player`: an orphaned sibling has no
 * `updatedAt` to expire and would sit forever, with the player_name half in
 * a public table every client downloads on its initial subscription. As
 * unreachable through this module's write paths as the other direction, and
 * as real: this project does operate the database through raw SQL (the
 * guest-admission spec drives its setting flips through the CLI's `sql`),
 * where `DELETE FROM player` alone is the intuitive kick. An identity may
 * appear twice (both
 * siblings orphaned); the second removePlayer is a no-op — row deletes
 * tolerate missing rows, the tolerance removePlayer already relies on.
 */
function sweepOrphanedSiblings(ctx: Ctx): void {
  for (const identity of orphanedSiblingIdentities(ctx)) removePlayer(ctx, identity);
}
// ── End player lifecycle ────────────────────────────────────────────────

// Server-authoritative movement: clients send only inputs, the server replays
// them through the same shared physics. Position cannot change any other way.
// Admission (batch size, ordering, token-bucket rate limit) lives in the pure
// evaluateInputBatch so it is unit-tested in @maple/shared.
export const submitInputs = spacetimedb.reducer(
  { startTick: t.u32(), inputs: t.array(t.u8()) },
  (ctx, { startTick, inputs }) => {
    const found = findMovementRows(ctx);
    if (!found) return;
    const { row, guard } = found;

    // Admission applies to moving, not just to joining: a player row whose
    // owner the rules would refuse (possible only as a leftover from before
    // the rules — e.g. a re-publish onto a database with pre-admission rows,
    // since every status change deletes the row transactionally) must not
    // keep driving authoritative movement. Reclaim it instead.
    const admission = evaluateJoin({
      membership: membershipOf(ctx, ctx.sender),
      guestsAllowed: guestsAllowed(ctx),
    });
    if (!admission.ok) {
      removePlayer(ctx, ctx.sender);
      return;
    }

    const verdict = evaluateInputBatch({
      batchLength: inputs.length,
      startTick,
      rowTick: row.tick,
      allowanceMicros: guard.allowanceMicros,
      nowMicros: ctx.timestamp.microsSinceUnixEpoch,
    });
    if (!verdict.ok) {
      logRejection(verdict.reason, ctx.sender.toHexString(), startTick, inputs.length, row.tick);
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
      tick: row.tick + inputs.length,
      online: true, // a stale disconnect event may have raced us; inputs prove liveness
      updatedAt: ctx.timestamp,
    });
  },
);

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
