// fallow-ignore-file coverage-gaps -- reducers only run inside a SpacetimeDB module host, so no unit test can import this file; the rules worth testing (admission, replay, retention) are delegated to evaluateInputBatch / replayInputs / isExpiredRow in @maple/shared and unit-tested there
import {
  type BatchRejectReason,
  type ConnectionPolicy,
  classifyConnection,
  DEFAULT_MAP,
  evaluateInputBatch,
  isExpiredRow,
  replayInputs,
  SPAWN_X,
  SPAWN_Y,
  stateFromRow,
} from '@maple/shared';
import { type InferSchema, type ReducerCtx, SenderError, t } from 'spacetimedb/server';
import { spacetimedb } from './tables';

/** The reducer context for this module's schema, for helpers that touch the db. */
type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;

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
 * Vets every connection before it can act in the world. Member privileges do not
 * exist yet: the approval gate that will consume this verdict arrives with the
 * account table in Phase 1.
 */
export const onConnect = spacetimedb.clientConnected((ctx) => {
  const auth = classifyConnection(ctx.senderAuth.jwt, CONNECTION_POLICY);
  if (auth.kind === 'audience-mismatch') {
    throw new SenderError('Unauthorized: this token was minted for another application');
  }
  if (auth.kind === 'member') {
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
// Admission (batch size, ordering, token-bucket rate limit) lives in the pure
// evaluateInputBatch so it is unit-tested in @maple/shared.
export const submitInputs = spacetimedb.reducer(
  { startTick: t.u32(), inputs: t.array(t.u8()) },
  (ctx, { startTick, inputs }) => {
    const row = ctx.db.player.identity.find(ctx.sender);
    if (!row) return;

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
export const join = spacetimedb.reducer((ctx) => {
  sweepExpiredRows(ctx);

  const existing = ctx.db.player.identity.find(ctx.sender);
  if (existing) {
    // Reload / network blip within the retention window: resume the saved
    // character where it stood, with a fresh input allowance.
    ctx.db.player.identity.update({
      ...existing,
      online: true,
      allowanceMicros: ctx.timestamp.microsSinceUnixEpoch,
      updatedAt: ctx.timestamp,
    });
    return;
  }

  const name = `Player-${ctx.sender.toHexString().slice(0, 6)}`;
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
});

// Keep the row on disconnect (marked offline) so a quick reconnect under the
// same identity resumes the character; join sweeps rows past their retention.
export const onDisconnect = spacetimedb.clientDisconnected((ctx) => {
  const row = ctx.db.player.identity.find(ctx.sender);
  if (!row) return;
  ctx.db.player.identity.update({ ...row, online: false, updatedAt: ctx.timestamp });
});
