/**
 * The global-scope text chat (ROADMAP Phase 2 第一弾): message validation,
 * the send rate limit, and the history retention rule. All pure and shared
 * so the server reducer stays a thin untestable wrapper while the client
 * mirrors the exact same rules for instant feedback — the
 * normalizeDisplayName / evaluateInputBatch precedent.
 */

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

export type ChatSendVerdict =
  | {
      ok: true;
      /** The advanced token-bucket marker to persist on the chat_guard row. */
      allowanceMicros: bigint;
    }
  | { ok: false; reason: 'rate-limited' };

/**
 * Pure admission check for one chat send — the input guard's token bucket
 * (evaluateInputBatch) reshaped for messages. `allowanceMicros` is the point
 * in time up to which the sender's messages are "paid for": each accepted
 * send advances it by CHAT_SEND_COST_MICROS, and a marker in the future
 * means the sender is ahead of the sustained rate and is refused until real
 * time catches up. The marker is floored at CHAT_BURST_MESSAGES-1 costs
 * behind `nowMicros`, so an idle sender banks at most one burst — never an
 * unbounded backlog. A sender with no guard row yet passes 0n (the epoch)
 * and gets exactly the full burst.
 */
export function evaluateChatSend(request: {
  /** Token-bucket marker persisted on the chat_guard row (micros since Unix epoch). */
  allowanceMicros: bigint;
  /** Server wall clock (micros since Unix epoch). */
  nowMicros: bigint;
}): ChatSendVerdict {
  const bankFloor = request.nowMicros - CHAT_SEND_COST_MICROS * BigInt(CHAT_BURST_MESSAGES - 1);
  const marker = request.allowanceMicros < bankFloor ? bankFloor : request.allowanceMicros;
  if (marker > request.nowMicros) return { ok: false, reason: 'rate-limited' };
  return { ok: true, allowanceMicros: marker + CHAT_SEND_COST_MICROS };
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
