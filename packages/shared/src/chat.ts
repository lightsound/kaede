/**
 * The global-scope text chat (ROADMAP Phase 2 第一弾): message validation,
 * the send rate limit, and the history retention rule. All pure and shared
 * so the server reducer stays a thin untestable wrapper while the client
 * mirrors the exact same rules for instant feedback — the
 * normalizeDisplayName / evaluateInputBatch precedent.
 */

import {
  evaluateSendAllowance,
  type SendAllowanceRequest,
  type SendAllowanceVerdict,
} from './sendAllowance';
import { type NormalizedTextVerdict, normalizeSingleLineText, type TextRejectReason } from './text';

/**
 * Longest allowed chat message, in Unicode code points. Enough for a few
 * sentences of Japanese; anything longer belongs in a document, and every
 * stored code point is entry egress for every future subscriber (the
 * retention rule below multiplies this by CHAT_HISTORY_MAX).
 */
export const CHAT_TEXT_MAX_LENGTH = 200;

export type ChatTextRejectReason = TextRejectReason;

export type ChatTextVerdict = NormalizedTextVerdict;

/**
 * Validates and normalizes one chat message: the display-name rules (NFC,
 * whitespace collapsing, category-C rejection) with a chat-sized length cap.
 * The chat input is a single-line field, so pasted newlines collapsing to
 * spaces is the intended reading, not a loss.
 */
export function normalizeChatText(raw: string): ChatTextVerdict {
  return normalizeSingleLineText(raw, CHAT_TEXT_MAX_LENGTH);
}

/**
 * Sustained send cost: one message per this many microseconds (1 msg/秒).
 * Above typing speed for any real conversation, so honest users never see
 * the limit; a flooder is capped at a rate the retention trim and every
 * subscriber's screen can absorb.
 */
export const CHAT_SEND_COST_MICROS = 1_000_000n;

/**
 * Burst allowance: how many messages may land back-to-back before the
 * sustained rate applies. Covers the "three quick lines" texture of real
 * chat without weakening the flood cap.
 */
export const CHAT_BURST_MESSAGES = 5;

/**
 * Pure admission check for one chat send: the shared send-rate token bucket
 * (see evaluateSendAllowance for the marker semantics) at the chat cost and
 * burst. The marker is persisted on the sender's chat_guard row.
 */
export function evaluateChatSend(request: SendAllowanceRequest): SendAllowanceVerdict {
  return evaluateSendAllowance(request, CHAT_SEND_COST_MICROS, CHAT_BURST_MESSAGES);
}

/**
 * How many chat messages the space keeps (保持方針). The whole public table
 * is downloaded by every entering client (the initial subscription has no
 * WHERE), so this bounds both entry egress and storage in one number:
 * 100 messages × ~200 code points worst case ≈ tens of KB per entry —
 * comparable to the player rows a busy room already ships. Enough history
 * to catch up on a workday's room chatter; anything older belongs to a
 * future archival design, not the realtime table.
 */
export const CHAT_HISTORY_MAX = 100;

/**
 * Which message rows to delete so at most `max` remain, oldest first. Ids
 * are the autoInc primary key, so ascending id is send order. Pure so the
 * retention rule is unit-tested; the server passes every current id (the
 * table is already bounded near `max`, so the enumeration stays cheap).
 */
export function chatOverflowIds(ids: readonly bigint[], max: number): bigint[] {
  if (ids.length <= max) return [];
  return [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, ids.length - max);
}

/**
 * How long a speech bubble stays above the sender's avatar (ms). Long
 * enough to read a full-length message, short enough that a busy room's
 * bubbles keep turning over.
 */
export const CHAT_BUBBLE_DURATION_MS = 6_000;

// ── チャットスコープ (ROADMAP Phase 3 増分④) ────────────────────────────
// Which conversation a message belongs to: 全体 / マップ / 会話グループ
// (VISION のコミュニケーション方針; the @mention DM is a table of its own).
// The vocabulary and its rules live here — next to the text and rate rules
// the same message obeys — rather than in a new shared file, because a new
// file's public signatures would add type-coupling edges past fallow's
// evidence cap (the zone.ts 増分③ precedent).

/** 全体: everyone in the space, whatever map or group they are in. */
export const CHAT_SCOPE_SPACE = 'space';

/** マップ: everyone whose player row is on the same map. */
export const CHAT_SCOPE_MAP = 'map';

/** 会話グループ: a conversation_group row (zone or huddle, kind-agnostic). */
export const CHAT_SCOPE_GROUP = 'group';

/**
 * The scope vocabulary. Narrowed by exact match everywhere (isChatScope —
 * the availability / reaction-palette precedent), so a row carrying a scope
 * this build does not know renders as nothing rather than leaking into 全体.
 */
export type ChatScope = typeof CHAT_SCOPE_SPACE | typeof CHAT_SCOPE_MAP | typeof CHAT_SCOPE_GROUP;

const CHAT_SCOPES: readonly string[] = [CHAT_SCOPE_SPACE, CHAT_SCOPE_MAP, CHAT_SCOPE_GROUP];

/** True when `value` is a scope this build knows (the raw column is a string). */
export function isChatScope(value: string): value is ChatScope {
  return CHAT_SCOPES.includes(value);
}

/**
 * Where the sender stands right now, as the scope rules read it: the map
 * its authoritative row is on, and the conversation group its membership
 * names (undefined while in none). Both server and client build this from
 * the same two rows — the player row and the group_member row.
 */
export interface ChatContext {
  readonly mapId: number;
  readonly groupId: bigint | undefined;
}

/**
 * Why a scoped send was refused. `wrong-map` and `not-a-member` are what a
 * client hears when the scope it addressed no longer matches where it
 * stands — a race (the portal or the occupancy pass landing between the
 * draft and the call) for an honest client, and the impersonation refusal
 * for a hostile one that named a group it never joined.
 */
export type ChatScopeRejectReason = 'unknown-scope' | 'wrong-map' | 'not-a-member';

/** One scoped send as the routing rule reads it: what the sender addressed. */
export interface ChatRouteRequest {
  /** The raw scope column value the sender named. */
  readonly scope: string;
  /**
   * The target the sender addressed: its own map's id (zero-extended) for
   * 'map', the conversation group's id for 'group', ignored for 'space'.
   */
  readonly target: bigint;
  /** Where the sender actually is, read from the authoritative rows. */
  readonly context: ChatContext;
}

/**
 * The routing a scoped send resolves to: the scope as stored, plus the
 * `target` column's value (see the chat_message table comment).
 */
export type ChatRouteVerdict =
  | { ok: true; scope: ChatScope; target: bigint }
  | { ok: false; reason: ChatScopeRejectReason };

/**
 * Rules on one scoped send — the ONE rule behind the client's send path and
 * the server's authority alike. The sender NAMES its target and this
 * verifies it against the context built from the authoritative rows; it
 * never adapts a mismatch into a different destination, following the DM
 * rule that a message whose addressee moved must fail loudly rather than
 * land somewhere its author did not mean (an in-flight teleport must not
 * dump the plaza's line into the meeting floor's log, and a group id the
 * sender never joined must not resolve to anything at all).
 *
 * A group send requires membership whether the group is open or closed:
 * reading an open conversation from outside is what オープン means (the
 * row-level-security filters let those rows through), but speaking INTO a
 * group one has not joined would make the boundary meaningless.
 */
export function resolveChatRoute(request: ChatRouteRequest): ChatRouteVerdict {
  const { scope, target, context } = request;
  if (!isChatScope(scope)) return { ok: false, reason: 'unknown-scope' };
  // 全体 addresses nothing, so there is nothing to verify: the column is 0
  // whatever the sender put there.
  if (scope === CHAT_SCOPE_SPACE) return { ok: true, scope, target: 0n };
  const own = chatTargetFor(scope, context);
  if (own === target) return { ok: true, scope, target: own };
  return { ok: false, reason: scope === CHAT_SCOPE_MAP ? 'wrong-map' : 'not-a-member' };
}

/**
 * The `target` column value a sender addresses for `scope` from where it
 * stands, or undefined when the scope has no target there (会話グループ
 * while in none) — the SENDING half of the pair whose verifying half is
 * resolveChatRoute. The client reads its context from the subscribed cache
 * at submit time (the DM candidate-resolution precedent: address whoever
 * you were looking at) and the server re-runs the verification against its
 * own rows, so the two halves cannot drift into different arithmetic.
 */
export function chatTargetFor(scope: ChatScope, context: ChatContext): bigint | undefined {
  if (scope === CHAT_SCOPE_SPACE) return 0n;
  if (scope === CHAT_SCOPE_MAP) return BigInt(context.mapId);
  return context.groupId;
}

/**
 * The scopes a sender may pick right now: 全体 always, マップ always (one
 * is always underfoot), 会話グループ only while a membership names one.
 * The selector offers exactly this (いまのコンテキストで送れないスコープは
 * 選ばせない — the DM rule that an unsendable draft must refuse rather than
 * fall back to somewhere else), and the ORDER is the widest audience first,
 * which is also the order the UI renders.
 */
export function chatScopeOptions(context: ChatContext): ChatScope[] {
  const scopes: ChatScope[] = [CHAT_SCOPE_SPACE, CHAT_SCOPE_MAP];
  if (context.groupId !== undefined) scopes.push(CHAT_SCOPE_GROUP);
  return scopes;
}

/**
 * The scope to send under given what is currently offered: the selection
 * when it is still there, else 全体. What keeps the selector honest when
 * the sender walks out of a group with 会話グループ selected — the control
 * can never sit on a scope the send would refuse. Takes the offered list
 * rather than the context because the control renders that list and never
 * sees the rows behind it.
 */
export function fallbackChatScope(selected: string, offered: readonly ChatScope[]): ChatScope {
  return offered.find((scope) => scope === selected) ?? CHAT_SCOPE_SPACE;
}

/** What 全体 is called wherever a scope names itself (the selector, the log). */
export const CHAT_SCOPE_SPACE_LABEL = '全体';

/** What an admin announcement is called in the log (the 強調 marker). */
export const CHAT_ANNOUNCEMENT_LABEL = 'アナウンス';

/** What a group scope falls back to when its group row is gone (deleted, or trimmed). */
const CHAT_SCOPE_GROUP_FALLBACK_LABEL = '会話グループ';

/** One log line's scope, as the panel and the E2E specs read it (see chatScopeTag). */
export interface ChatScopeTagRequest {
  readonly scope: string;
  /** The announcement flag off the row. */
  readonly announcement: boolean;
  /** The target map's display name, when the scope is 'map' and the map is known. */
  readonly mapName: string | undefined;
  /** The target group's name, when the scope is 'group' and the row is still there. */
  readonly groupName: string | undefined;
}

/**
 * The scope marker on one log line — 全体 / the map's name / the group's
 * name / アナウンス — composed here so the panel and the specs share one
 * string (the statusLabel precedent). Undefined for a scope this build
 * does not know: an unknown row renders as a plain line rather than
 * claiming a scope it cannot name.
 */
export function chatScopeTag(request: ChatScopeTagRequest): string | undefined {
  if (request.announcement) return CHAT_ANNOUNCEMENT_LABEL;
  if (request.scope === CHAT_SCOPE_SPACE) return CHAT_SCOPE_SPACE_LABEL;
  if (request.scope === CHAT_SCOPE_MAP) return request.mapName;
  if (request.scope === CHAT_SCOPE_GROUP) {
    return request.groupName ?? CHAT_SCOPE_GROUP_FALLBACK_LABEL;
  }
  return undefined;
}
