// fallow-ignore-file coverage-gaps -- reducers only run inside a SpacetimeDB module host, so no unit test can import this file; the rules worth testing (admission, replay, retention) are delegated to evaluateInputBatch / replayInputs / isExpiredRow in @maple/shared and unit-tested there
import {
  asMembership,
  type BatchRejectReason,
  type ConnectionPolicy,
  classifyConnection,
  DEFAULT_MAP,
  evaluateApproval,
  evaluateInputBatch,
  evaluateJoin,
  evaluateRemoval,
  evaluateRename,
  evaluateSettingChange,
  guestsAllowedFrom,
  initialMembership,
  isExpiredRow,
  type JoinRefusalReason,
  type Membership,
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
 * per-tab identity. Only `localhost` is known today; Maincloud's issuer has to
 * be observed and added before unrecognised issuers can be refused outright.
 */
const CONNECTION_POLICY: ConnectionPolicy = {
  memberIssuers: [CLERK_DEVELOPMENT_ISSUER],
  memberAudience: 'kaede-spacetimedb',
  guestIssuers: ['localhost'],
};

/**
 * Guarantees a member has an account row. Only members get one: a member's
 * Identity is stable across devices and reconnects (derived from the
 * provider's issuer+subject), so the row it maps to genuinely is the same
 * person; a guest Identity is per-tab and transient, and an account keyed by
 * it would be garbage the moment the tab closes.
 *
 * find-then-insert is race-free here: reducers are atomic transactions that
 * the host serializes, so two first-time connections from the same member
 * (two tabs, two devices) cannot interleave — the second clientConnected
 * runs after the first committed and finds its row.
 */
function ensureAccount(ctx: Ctx): void {
  if (ctx.db.account.identity.find(ctx.sender)) return;
  ctx.db.account.insert({
    id: 0n, // 0 asks autoInc to assign the real id
    identity: ctx.sender,
    displayName: undefined,
    createdAt: ctx.timestamp,
    updatedAt: ctx.timestamp,
  });
}

/**
 * Guarantees a member has a membership row in the space, alongside its
 * account. The very first member ever seen becomes the approved admin — the
 * seeding rationale lives on initialMembership in @maple/shared — and
 * everyone after starts pending, which is what the waiting room shows.
 *
 * Also the re-application path: a removed member's rows are gone, so its
 * next connection lands here and files a fresh pending membership.
 */
function ensureSpaceMember(ctx: Ctx): void {
  if (ctx.db.spaceMember.identity.find(ctx.sender)) return;
  ctx.db.spaceMember.insert({
    identity: ctx.sender,
    // The public projection of the account's persisted name (may predate
    // this table on databases published before it existed).
    displayName: ctx.db.account.identity.find(ctx.sender)?.displayName,
    ...initialMembership(ctx.db.spaceMember.count() === 0n),
    requestedAt: ctx.timestamp,
    updatedAt: ctx.timestamp,
  });
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
 * Vets every connection before it can act in the world. Note this reducer
 * only classifies and records — it never refuses admittable kinds. Refusals
 * live in `join`: a SenderError thrown here would close the socket, and the
 * client's reconnect loop (exponential backoff in sync.ts) would swallow the
 * reason before any UI could show it. `join` refusals arrive as ordinary
 * reducer errors on an open connection instead.
 */
export const onConnect = spacetimedb.clientConnected((ctx) => {
  const auth = classifyConnection(ctx.senderAuth.jwt, CONNECTION_POLICY);
  if (auth.kind === 'audience-mismatch') {
    throw new SenderError('Unauthorized: this token was minted for another application');
  }
  if (auth.kind === 'member') {
    ensureAccount(ctx);
    ensureSpaceMember(ctx);
    console.info(`member connected: sub=${auth.subject}`);
    return;
  }
  if (auth.kind === 'unregistered-issuer') {
    console.warn(`guest connected with an unregistered issuer: ${auth.issuer}`);
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
  reason: BatchRejectReason | JoinRefusalReason,
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
// Admission (batch size, ordering, token-bucket rate limit) lives in the pure
// evaluateInputBatch so it is unit-tested in @maple/shared.
export const submitInputs = spacetimedb.reducer(
  { startTick: t.u32(), inputs: t.array(t.u8()) },
  (ctx, { startTick, inputs }) => {
    const row = ctx.db.player.identity.find(ctx.sender);
    if (!row) return;

    // Holding a player row is not authority to move it: a row can outlive the
    // standing that earned it (one left behind by a module published before
    // admission existed, whose owner is only pending now), and `join` alone
    // gating entry would let such a row keep driving an avatar. Re-checked
    // against the very rule join enforces, so the two cannot drift.
    const admission = evaluateJoin({
      membership: membershipOf(ctx, ctx.sender),
      guestsAllowed: guestsAllowed(ctx),
    });
    if (!admission.ok) {
      logRejection(admission.reason, ctx.sender.toHexString(), startTick, inputs.length, row.tick);
      return;
    }

    const verdict = evaluateInputBatch({
      batchLength: inputs.length,
      startTick,
      rowTick: row.tick,
      allowanceMicros: row.allowanceMicros,
      nowMicros: ctx.timestamp.microsSinceUnixEpoch,
    });
    if (!verdict.ok) {
      logRejection(verdict.reason, ctx.sender.toHexString(), startTick, inputs.length, row.tick);
      return;
    }

    const s = replayInputs(stateFromRow(row), inputs, DEFAULT_MAP);

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
      allowanceMicros: verdict.allowanceMicros,
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
  for (const identity of stale) ctx.db.player.identity.delete(identity);
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
  spawnOrResume(ctx);
});

/** Resumes the sender's surviving player row, or spawns a fresh one. */
function spawnOrResume(ctx: Ctx): void {
  const existing = ctx.db.player.identity.find(ctx.sender);
  // Precedence (persisted account name > resumed row's name > default) lives
  // in resolveJoinName, unit-tested in @maple/shared.
  const name = resolveJoinName({
    persistedName: ctx.db.account.identity.find(ctx.sender)?.displayName,
    resumedRowName: existing?.name,
    identityHex: ctx.sender.toHexString(),
  });

  if (existing) {
    // Reload / network blip within the retention window: resume the saved
    // character where it stood, with a fresh input allowance.
    ctx.db.player.identity.update({
      ...existing,
      name,
      online: true,
      allowanceMicros: ctx.timestamp.microsSinceUnixEpoch,
      updatedAt: ctx.timestamp,
    });
    return;
  }

  ctx.db.player.insert({
    identity: ctx.sender,
    name,
    x: SPAWN_X,
    y: SPAWN_Y,
    vx: 0,
    vy: 0,
    facing: 1,
    onGround: false,
    rope: -1,
    tick: 0,
    online: true,
    allowanceMicros: ctx.timestamp.microsSinceUnixEpoch,
    updatedAt: ctx.timestamp,
  });
}

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

// Renames the sender everywhere it is visible right now (its player row) and,
// for members, persists the name on the account so every future join — any
// device, any reconnect — spawns under it. Guests have no account, so their
// rename lives only as long as their per-tab identity's player row.
// Admission (name validation, refusing a rename with nowhere to land) is the
// pure evaluateRename, unit-tested in @maple/shared — the same rules the
// client checks against before sending.
export const setDisplayName = spacetimedb.reducer({ name: t.string() }, (ctx, { name }) => {
  const hasAccount = ctx.db.account.identity.find(ctx.sender) !== null;
  const row = ctx.db.player.identity.find(ctx.sender);
  const verdict = evaluateRename({
    rawName: name,
    hasAccount,
    hasPlayerRow: row !== null,
  });
  if (!verdict.ok) {
    throw new SenderError(`Rename refused (${verdict.reason})`);
  }
  persistMemberName(ctx, verdict.name);
  if (row !== null) {
    ctx.db.player.identity.update({ ...row, name: verdict.name, updatedAt: ctx.timestamp });
  }
});

// Flips a pending membership to approved (承認制の承認側). The admin check is
// server-side and final — the client-side gating of the admin panel is
// cosmetic. The approved member's waiting client sees its space_member row
// update and joins on its own.
export const approveMember = spacetimedb.reducer(
  { identity: t.identity() },
  (ctx, { identity }) => {
    const target = ctx.db.spaceMember.identity.find(identity);
    const verdict = evaluateApproval({
      actor: membershipOf(ctx, ctx.sender),
      target: target === null ? undefined : asMembership(target),
    });
    if (!verdict.ok) {
      throw new SenderError(`approve_member refused (${verdict.reason})`);
    }
    if (target === null) {
      // Unreachable — evaluateApproval refuses a missing target as
      // no-such-member — but narrowing must not read as a silent no-op.
      throw new SenderError('approve_member refused (no-such-member)');
    }
    ctx.db.spaceMember.identity.update({
      ...target,
      status: 'approved',
      updatedAt: ctx.timestamp,
    });
  },
);

// Removes a member entirely: membership, account, and any player row go in
// one transaction, so the avatar leaves the world the moment the admin acts.
// Deleting the account too is deliberate — the next connection recreates it
// pending (= a fresh application) via ensureAccount/ensureSpaceMember, at
// the cost of the removed member's persisted profile, which is what
// "removal" should mean. The removed client reacts to its vanished
// membership row by reconnecting into that re-application (decideAdmission's
// `reapply`), rather than falling through to the guest path.
export const removeMember = spacetimedb.reducer({ identity: t.identity() }, (ctx, { identity }) => {
  const verdict = evaluateRemoval({
    actor: membershipOf(ctx, ctx.sender),
    target: membershipOf(ctx, identity),
  });
  if (!verdict.ok) {
    throw new SenderError(`remove_member refused (${verdict.reason})`);
  }
  ctx.db.spaceMember.identity.delete(identity);
  ctx.db.account.identity.delete(identity);
  ctx.db.player.identity.delete(identity);
});

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
  for (const identity of guests) ctx.db.player.identity.delete(identity);
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
