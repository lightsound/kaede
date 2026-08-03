// fallow-ignore-file coverage-gaps -- reducers only run inside a SpacetimeDB module host, so no unit test can import this file; the rules worth testing (validation, rate limits, retention) are delegated to normalizeChatText / isReactionEmoji / isAvailability / normalizeStatusText / evaluateChatSend / evaluateReactionSend / evaluateStatusSend / chatOverflowIds in @maple/shared and unit-tested there

// The posting reducers (ROADMAP Phase 2): what someone in the world says,
// gestures or claims about themselves — the global-scope chat, the emoji
// reactions and the manual status. Split from reducers.ts (which keeps the
// world lifecycle, membership and settings) because this section grows
// with every Phase 2/3 conversation feature while depending on the
// lifecycle only through findAdmittedWorldRows.
import {
  type Availability,
  CHAT_HISTORY_MAX,
  chatOverflowIds,
  evaluateChatSend,
  evaluateReactionSend,
  evaluateStatusSend,
  isAvailability,
  isReactionEmoji,
  normalizeChatText,
  normalizeStatusText,
  type SendAllowanceRequest,
  type SendAllowanceVerdict,
  statusViewOf,
} from '@maple/shared';
import { SenderError, t } from 'spacetimedb/server';
import { spacetimedb } from './tables';
import { type Ctx, findAdmittedWorldRows, type SenderIdentity, type WorldRows } from './world';

/**
 * The shared preamble of every posting reducer (send_chat_message /
 * send_reaction): the sender's world rows, or undefined after a refusal.
 * The two refusal reasons split along the loud/silent rule documented on
 * sendChatMessage, and the verdict's contract (WorldRowsVerdict) is what
 * makes each branch safe: `not-in-world` wrote nothing, so it may throw;
 * `reclaimed` just deleted the sender's rows and must commit, so it stays
 * a logged return.
 */
function findPostingSender(ctx: Ctx, reducerName: string): WorldRows | undefined {
  const found = findAdmittedWorldRows(ctx);
  if (found.ok) return found.rows;
  if (found.reason === 'not-in-world') {
    throw new SenderError(`${reducerName} refused (not-in-world)`);
  }
  console.warn(`${reducerName} dropped (reclaimed): sender=${ctx.sender.toHexString()}`);
  return undefined;
}

/** A send-rate token-bucket marker table (identity → allowanceMicros). */
type SendGuardTable =
  | Ctx['db']['chatGuard']
  | Ctx['db']['reactionGuard']
  | Ctx['db']['statusGuard'];

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
  evaluate: (request: SendAllowanceRequest) => SendAllowanceVerdict,
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

/**
 * The shared preamble of the row-writing sends that need no sender rows
 * (reactions and the status columns): eligibility plus the rate charge.
 * False when the silent reclaim path refused — the caller must RETURN
 * without writing (WorldRowsVerdict); every loud refusal throws inside.
 * send_chat_message keeps calling the pieces itself: it needs the sender's
 * rows (the name snapshot on the message), not just admission.
 */
function admitGuardedSend(
  ctx: Ctx,
  reducerName: string,
  guardTable: SendGuardTable,
  evaluate: (request: SendAllowanceRequest) => SendAllowanceVerdict,
): boolean {
  if (!findPostingSender(ctx, reducerName)) return false;
  chargeSendAllowance(ctx, guardTable, evaluate, reducerName);
  return true;
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
// - No player row at all (the common refusal; nothing was written): loud,
//   so the sender's client hears it (NetHooks.onChatRefused) instead of
//   the message silently evaporating.
// - The verdict says `reclaimed`: a reclaim just happened (lost admission,
//   or a broken sibling pair) and must commit, so this refusal stays
//   silent — the sender still gets feedback, because deleting its player
//   row reaches it as a row event and flips its UI to the admission
//   notice.
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

/** An identity-keyed table, as the upsert-row features (reaction, status) shape theirs. */
interface IdentityKeyedTable<Row extends { identity: SenderIdentity }> {
  insert(row: Row): unknown;
  identity: {
    find(identity: SenderIdentity): Row | null;
    update(row: Row): unknown;
  };
}

/**
 * Writes one identity-keyed upsert row: the row-write half every
 * upsert-row feature shares (the reaction, and both status columns
 * through writeStatus), so the find/update/insert dance exists once.
 */
function upsertByIdentity<Row extends { identity: SenderIdentity }>(
  table: IdentityKeyedTable<Row>,
  row: Row,
): void {
  if (table.identity.find(row.identity)) table.identity.update(row);
  else table.insert(row);
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
// no text normalization questions apply; the check runs before the
// admission preamble, which is safe because both are loud pre-write
// refusals (nothing to roll back either way). Unlike chat there is no
// client-side bucket mirror and no refusal notice: a reaction is a
// transient gesture, so a burst-exceeding click simply not appearing is
// feedback enough (an accepted simplification; the server refusal above
// stays loud for the reducer log).
export const sendReaction = spacetimedb.reducer({ emoji: t.string() }, (ctx, { emoji }) => {
  if (!isReactionEmoji(emoji)) {
    throw new SenderError('send_reaction refused (unknown-emoji)');
  }
  if (!admitGuardedSend(ctx, 'send_reaction', ctx.db.reactionGuard, evaluateReactionSend)) return;
  upsertByIdentity(ctx.db.reaction, { identity: ctx.sender, emoji, sentAt: ctx.timestamp });
});

/** One VALIDATED column of the status row, as either reducer writes it. */
type StatusPatch = { availability: Availability } | { text: string };

/**
 * The shared body of both status reducers, everything after their (loud,
 * pre-write) validation: eligibility, the rate charge, and the
 * single-column write onto the sender's status row. The other column
 * defaults through statusViewOf — the same "missing row means
 * DEFAULT_STATUS" rule clients read with, unit-tested in @maple/shared.
 * The server-side read-modify-write is the point of having two reducers
 * over one: each control sends only its own validated value, so a stale
 * client-side view of the OTHER column can never be written back.
 */
function writeStatus(ctx: Ctx, reducerName: string, patch: StatusPatch): void {
  if (!admitGuardedSend(ctx, reducerName, ctx.db.statusGuard, evaluateStatusSend)) return;
  const existing = ctx.db.playerStatus.identity.find(ctx.sender);
  upsertByIdentity(ctx.db.playerStatus, {
    identity: ctx.sender,
    ...statusViewOf(existing),
    ...patch,
  });
}

// Sets the sender's availability (ステータス手動切替 — ROADMAP Phase 2):
// online / away / busy, shown persistently beside the name until changed.
// Deliberately unrelated to the connection-liveness machinery: the manual
// 離席 is the player's own claim, while player.online and the idle guard
// (net.package/idle.ts) answer "is the socket alive" — neither reads nor
// writes the other. Eligibility is exactly send_chat_message's (presence
// in the world plus the admission re-check, so guests may set a status
// whenever they may be in the world, and the guests_allowed kick deletes
// their row in the same transaction). Which refusals are loud follows
// sendChatMessage's rule verbatim: no player row, an unknown availability
// and the rate limit all throw before any write; the reclaim path stays
// silent because its row deletion must commit. The availability is
// validated by exact match against the shared vocabulary (isAvailability
// — the reaction-palette precedent), so free-form strings never reach the
// public table through this column.
export const setAvailability = spacetimedb.reducer(
  { availability: t.string() },
  (ctx, { availability }) => {
    if (!isAvailability(availability)) {
      throw new SenderError('set_availability refused (unknown-availability)');
    }
    writeStatus(ctx, 'set_availability', { availability });
  },
);

// Sets (or, with an empty text, clears) the sender's free-text status line
// (自由文ステータス — ROADMAP Phase 2). Everything about set_availability
// — eligibility, guests, the loud/silent rule, the shared guard bucket —
// applies verbatim (both delegate to writeStatus); the validation is
// normalizeStatusText (the normalizeSingleLineText rules at the status
// cap, with '' accepted as the clear operation), shared with the client's
// form so a text that leaves the UI is never refused for its content.
export const setStatusText = spacetimedb.reducer({ text: t.string() }, (ctx, { text }) => {
  const verdict = normalizeStatusText(text);
  if (!verdict.ok) throw new SenderError(`set_status_text refused (${verdict.reason})`);
  writeStatus(ctx, 'set_status_text', { text: verdict.text });
});
