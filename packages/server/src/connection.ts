// fallow-ignore-file coverage-gaps -- reducers only run inside a SpacetimeDB module host, so no unit test can import this file; the rules worth testing (token classification, member-issuer selection, disconnect labeling) are delegated to classifyConnection / memberIssuersFor / disconnectReasonFrom in @kaede/shared and unit-tested there

// The connection lifecycle reducers: vetting every connection's token
// (onConnect — which issuers mean member and guest), the idle guard's
// announce, and the disconnect bookkeeping, plus the private
// connection-event log both ends write. What a member's connect writes to
// the account row lives in account.ts (rename shares it).
import {
  CONNECTION_EVENT_MAX,
  type ConnectionPolicy,
  classifyConnection,
  DISCONNECT_INTENT_FRESH_MS,
  disconnectReasonFrom,
  memberIssuersFor,
} from '@kaede/shared';
import { SenderError } from 'spacetimedb/server';
import { ensureAccount } from './account';
import { spacetimedb } from './tables';
import { type Ctx, syncNameOnline, trimHistory } from './world';

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
 * RESUME_MAX_FAILURES attempts (client connection.ts) and recovers as a
 * fresh guest in ~30s. A signed-in client re-mints its OIDC token on every
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
