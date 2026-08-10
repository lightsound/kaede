// fallow-ignore-file coverage-gaps -- reducers only run inside a SpacetimeDB module host, so no unit test can import this file; the rules worth testing (validation, mention resolution, rate limits, retention) are delegated to normalizeChatText / planChatDraft / isReactionEmoji / isGestureKind / isAvailability / normalizeStatusText / evaluateChatSend / evaluateReactionSend / evaluateStatusSend / chatOverflowIds in @kaede/shared and unit-tested there

// The posting reducers (ROADMAP Phase 2): what someone in the world says,
// gestures or claims about themselves — the global-scope chat, the
// @mention DMs, the emoji reactions and the manual status. Split from
// reducers.ts (which keeps the world lifecycle, membership and settings)
// because this section grows with every Phase 2/3 conversation feature
// while depending on the lifecycle only through findAdmittedWorldRows.
import {
  type Availability,
  CHAT_HISTORY_MAX,
  CHAT_SCOPE_SPACE,
  type ChatContext,
  type ChatScope,
  DM_HISTORY_MAX,
  evaluateChatSend,
  evaluateReactionSend,
  evaluateSendAllowance,
  evaluateStatusSend,
  GESTURE_BURST_SENDS,
  GESTURE_SEND_COST_MICROS,
  isAvailability,
  isGestureKind,
  isReactionEmoji,
  normalizeChatText,
  normalizeStatusText,
  resolveChatRoute,
  type SendAllowanceRequest,
  type SendAllowanceVerdict,
  statusViewOf,
} from '@kaede/shared';
import { SenderError, t } from 'spacetimedb/server';
import { spacetimedb } from './tables';
import {
  type Ctx,
  chargeSendAllowance,
  findPostingSender,
  requireAdmin,
  type SenderIdentity,
  type SendGuardTable,
  trimHistory,
  type WorldRows,
} from './world';

/**
 * The shared preamble of the row-writing sends that need no sender rows
 * (reactions and the status columns): eligibility plus the rate charge
 * (chargeSendAllowance — moved to world.ts when enter_portal joined the
 * guarded reducers). False when the silent reclaim path refused — the
 * caller must RETURN without writing (WorldRowsVerdict); every loud
 * refusal throws inside. send_chat_message keeps calling the pieces
 * itself: it needs the sender's rows (the name snapshot on the message),
 * not just admission.
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
// Validation and the rate rule are pure functions in @kaede/shared, shared
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
export const sendChatMessage = spacetimedb.reducer(
  { text: t.string(), scope: t.string(), target: t.u64() },
  (ctx, { text, scope, target }) => {
    const draft = admitMessage(ctx, 'send_chat_message', text);
    if (!draft) return;
    const route = resolveChatRoute({ scope, target, context: chatContextOf(ctx, draft.rows.row) });
    if (!route.ok) throw new SenderError(`send_chat_message refused (${route.reason})`);
    chargeSendAllowance(ctx, ctx.db.chatGuard, evaluateChatSend, 'send_chat_message');
    appendChatMessage(ctx, draft.rows.nameRow.name, draft.text, route.scope, route.target, false);
  },
);

/**
 * The preamble every message sender shares (chat, DM, announcement): the
 * sender's world rows plus the validated body, or undefined after the
 * silent reclaim refusal — in which case the caller must RETURN without
 * writing (the WorldRowsVerdict contract; every loud refusal throws
 * inside, all of them before any write). One function because the three
 * senders' first lines were otherwise identical down to the tokens, which
 * is what the clone gate exists to catch.
 */
function admitMessage(
  ctx: Ctx,
  reducerName: string,
  text: string,
): { rows: WorldRows; text: string } | undefined {
  const found = findPostingSender(ctx, reducerName);
  if (!found) return undefined;
  const verdict = normalizeChatText(text);
  if (!verdict.ok) throw new SenderError(`${reducerName} refused (${verdict.reason})`);
  return { rows: found, text: verdict.text };
}

/**
 * Where the sender stands, for the scope rules: its authoritative map and
 * the conversation group its membership names. Built from the server's own
 * rows on every send — the whole reason a client cannot address a group it
 * never joined (see resolveChatRoute in @kaede/shared).
 */
function chatContextOf(ctx: Ctx, row: WorldRows['row']): ChatContext {
  const member = ctx.db.groupMember.identity.find(ctx.sender);
  return { mapId: row.mapId, groupId: member === null ? undefined : member.groupId };
}

/**
 * Appends one message to the chat history and trims it — the row write both
 * senders share (send_chat_message and send_announcement), so the retention
 * cap and the column defaults cannot drift between them. The cap stays ONE
 * global CHAT_HISTORY_MAX across every scope (ROADMAP 増分④ の履歴の
 * 決め打ち): the number bounds storage and entry egress for the table as a
 * whole, which is what a per-scope cap would stop doing.
 */
function appendChatMessage(
  ctx: Ctx,
  senderName: string,
  text: string,
  scope: ChatScope,
  target: bigint,
  announcement: boolean,
): void {
  ctx.db.chatMessage.insert({
    id: 0n, // 0 asks autoInc to assign the real id
    sender: ctx.sender,
    senderName,
    text,
    sentAt: ctx.timestamp,
    scope,
    target,
    announcement,
  });
  trimHistory(ctx.db.chatMessage, CHAT_HISTORY_MAX);
}

// Posts one space-wide admin announcement (ROADMAP Phase 3 増分④ 管理者の
// 全体アナウンス): a 'space'-scoped message flagged `announcement`, so it
// reaches everyone — other maps, and the members of a closed meeting alike
// — and renders 強調. The admin check is evaluateSettingChange, the same
// acting-admin rule set_guests_allowed and the zone reducers use, so
// guests and ordinary members are refused server-side and the panel's
// gating stays cosmetic. Presence in the world is required too, like every
// posting reducer: the row snapshots the sender's display name, which only
// a player row has.
//
// Deliberately NOT charged against chat_guard, unlike the DM: this send
// leaves from the admin panel, not the chat input whose client-side mirror
// (ChatPanel's allowanceRef) charges per submit — a bucket advanced behind
// the mirror's back would turn honest chat sends into surprise refusals
// (the reaction_guard reasoning). It gets no bucket of its own either, for
// the reason the zone admin reducers have none: the action is admin-gated
// and rare.
export const sendAnnouncement = spacetimedb.reducer({ text: t.string() }, (ctx, { text }) => {
  requireAdmin(ctx, 'send_announcement');
  const draft = admitMessage(ctx, 'send_announcement', text);
  if (!draft) return;
  appendChatMessage(ctx, draft.rows.nameRow.name, draft.text, CHAT_SCOPE_SPACE, 0n, true);
});

/**
 * The recipient's current display name, or a loud refusal when the DM has
 * nowhere valid to go. What "valid" means is the recipient-eligibility
 * decision (recorded in the PR): present in the world AND online — the rule
 * the sender's client resolved the mention against (its candidate list is
 * the online players it renders), re-checked here because client resolution
 * is never trusted with row creation: an invented identity must not get
 * rows accumulated for it, and a resolution raced by the recipient leaving
 * must fail loudly rather than write history addressed to nobody. Checking
 * `online` (not the mere row, which lingers ~10 minutes after leaving)
 * keeps the server's notion of "addressable" the same as the sender's
 * screen. The name row is a sibling of the player row by construction; a
 * missing one is the broken-pair case, refused the same way rather than
 * snapshotting an empty name.
 */
function resolveDmRecipientName(ctx: Ctx, recipient: SenderIdentity): string {
  const row = ctx.db.player.identity.find(recipient);
  const nameRow = ctx.db.playerName.identity.find(recipient);
  if (row === null || !row.online || nameRow === null) {
    throw new SenderError('send_dm refused (recipient-not-in-world)');
  }
  return nameRow.name;
}

// Sends one @mention DM (ROADMAP Phase 2): a private message delivered only
// to its sender and recipient by the dm_message row-level-security filter
// (see tables.ts). The argument is the RESOLVED recipient identity, not the
// mentioned name — the client resolves the mention against the players on
// its screen (planChatDraft in @kaede/shared, where the rules are
// unit-tested) so the message goes to whoever the sender was looking at,
// not to whoever holds the name by the time the call lands (rename races).
// The server re-validates what it must never take on faith: the sender's
// eligibility (findPostingSender — presence in the world plus the admission
// re-check, exactly send_chat_message's; guests may DM whenever they may be
// in the world, on both ends), the body (the shared chat text rules), and
// the recipient (resolveDmRecipientName above).
//
// The rate charge goes against the sender's CHAT bucket, deliberately not a
// dm_guard of its own: DMs are sent from the same chat input, whose
// client-side mirror (ChatPanel's allowanceRef) charges per submit without
// knowing which kind it was — a separate server bucket would let the mirror
// and the authority drift apart on every DM (the reverse of the reason
// reaction_guard is separate). One bucket also means one flood cap over
// everything a person can type into the room.
//
// Which refusals are loud follows sendChatMessage's rule verbatim: every
// throw above and inside chargeSendAllowance happens before any write; the
// reclaim path stays silent because its row deletion must commit.
export const sendDm = spacetimedb.reducer(
  { recipient: t.identity(), text: t.string() },
  (ctx, { recipient, text }) => {
    const draft = admitMessage(ctx, 'send_dm', text);
    if (!draft) return;
    const recipientName = resolveDmRecipientName(ctx, recipient);
    chargeSendAllowance(ctx, ctx.db.chatGuard, evaluateChatSend, 'send_dm');
    ctx.db.dmMessage.insert({
      id: 0n, // 0 asks autoInc to assign the real id
      sender: ctx.sender,
      recipient,
      senderName: draft.rows.nameRow.name,
      recipientName,
      text: draft.text,
      sentAt: ctx.timestamp,
    });
    trimHistory(ctx.db.dmMessage, DM_HISTORY_MAX);
  },
);

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
 * `build` receives the existing row so a caller merging against it
 * (writeStatus) shares this one lookup instead of finding twice.
 */
function upsertByIdentity<Row extends { identity: SenderIdentity }>(
  table: IdentityKeyedTable<Row>,
  identity: SenderIdentity,
  build: (existing: Row | null) => Row,
): void {
  const existing = table.identity.find(identity);
  const row = build(existing);
  if (existing) table.identity.update(row);
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
  upsertByIdentity(ctx.db.reaction, ctx.sender, () => ({
    identity: ctx.sender,
    emoji,
    sentAt: ctx.timestamp,
  }));
});

/**
 * The gesture rate rule at the shared cost and burst — kept a LOCAL
 * function rather than a shared export (the 増分③ rate-wrapper rule:
 * another shared function whose public signature references the
 * sendAllowance types would add type-coupling evidence edges at the cap).
 */
function evaluateGestureSend(request: SendAllowanceRequest): SendAllowanceVerdict {
  return evaluateSendAllowance(request, GESTURE_SEND_COST_MICROS, GESTURE_BURST_SENDS);
}

// Plays (or, with an empty string, clears) the sender's pose gesture
// (ROADMAP Phase 5 ①c): sit / sleep / dance / wave, rendered as the
// avatar's pose by every client. Everything about send_reaction —
// eligibility, guests, the loud/silent rule, the vocabulary validation by
// exact match — applies verbatim; the differences are the display
// convention (see the gesture table comment) and the empty-string clear:
// standing up WITHOUT moving is a legitimate intent (movement is the
// other clear path — clearGestureOnMove), and clearing writes/deletes a
// public row, so it is charged like any other send. Clearing when no row
// exists is a no-op that still pays: refusing it loudly would make
// double-clicking a cancel button an error, which is worse than the
// wasted bucket token.
export const playGesture = spacetimedb.reducer({ gesture: t.string() }, (ctx, { gesture }) => {
  if (gesture !== '' && !isGestureKind(gesture)) {
    throw new SenderError('play_gesture refused (unknown-gesture)');
  }
  if (!admitGuardedSend(ctx, 'play_gesture', ctx.db.gestureGuard, evaluateGestureSend)) return;
  writeGestureRow(ctx, gesture);
});

/** The row half of play_gesture: '' deletes (the clear), a gesture upserts. */
function writeGestureRow(ctx: Ctx, gesture: string): void {
  if (gesture === '') {
    ctx.db.gesture.identity.delete(ctx.sender);
    return;
  }
  upsertByIdentity(ctx.db.gesture, ctx.sender, () => ({
    identity: ctx.sender,
    gesture,
    sentAt: ctx.timestamp,
  }));
}

/** One VALIDATED column of the status row, as either reducer writes it. */
type StatusPatch = { availability: Availability } | { text: string };

/**
 * The shared body of both status reducers, everything after their (loud,
 * pre-write) validation: eligibility, the rate charge, and the
 * single-column write onto the sender's status row. The other column
 * defaults through statusViewOf — the same "missing row means
 * DEFAULT_STATUS" rule clients read with, unit-tested in @kaede/shared.
 * The server-side read-modify-write is the point of having two reducers
 * over one: each control sends only its own validated value, so a stale
 * client-side view of the OTHER column can never be written back.
 */
function writeStatus(ctx: Ctx, reducerName: string, patch: StatusPatch): void {
  if (!admitGuardedSend(ctx, reducerName, ctx.db.statusGuard, evaluateStatusSend)) return;
  upsertByIdentity(ctx.db.playerStatus, ctx.sender, (existing) => ({
    identity: ctx.sender,
    ...statusViewOf(existing),
    ...patch,
  }));
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
