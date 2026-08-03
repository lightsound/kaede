/**
 * Emoji reactions above the avatar (ROADMAP Phase 2): the fixed palette and
 * its exact-match validation, the display window, and the send rate limit.
 * All pure and shared — the chat.ts precedent — so the server reducer stays
 * a thin untestable wrapper, the client's palette buttons can only ever
 * offer what the server accepts, and the e2e specs can time their polls off
 * the same display constant (shared is the one workspace they may import).
 */

import {
  evaluateSendAllowance,
  type SendAllowanceRequest,
  type SendAllowanceVerdict,
} from './sendAllowance';

/**
 * The fixed reaction palette. Senders pick from these; the server refuses
 * anything else by exact string match (isReactionEmoji), so no free-form
 * text — and none of the ZWJ-sequence normalization questions that come
 * with it — can enter the public reaction table. Every entry is a single
 * emoji with at most a VS16 variation selector (no ZWJ compositions), so
 * every platform renders the palette the same way.
 */
export const REACTION_EMOJIS = ['👍', '❤️', '😂', '🎉', '😮', '🙏'] as const;

export type ReactionEmoji = (typeof REACTION_EMOJIS)[number];

/** Whether `value` is exactly one of the palette emojis (the send validation). */
export function isReactionEmoji(value: string): value is ReactionEmoji {
  return REACTION_EMOJIS.some((emoji) => emoji === value);
}

/**
 * How long a reaction stays above the sender's avatar (ms). Long enough
 * that the e2e polls reliably observe it (they sample every few hundred
 * ms), short enough to feel like a gesture rather than a status — and a
 * notch under CHAT_BUBBLE_DURATION_MS, so a reaction to a message never
 * outlives the message's own bubble.
 */
export const REACTION_DURATION_MS = 5_000;

/**
 * Sustained send cost: one reaction per this many microseconds (1回/秒),
 * with a burst of REACTION_BURST_SENDS. The same numbers as chat — above
 * any honest clicking rate — but charged against a bucket of its own
 * (reaction_guard), so reacting never eats into the sender's chat
 * allowance; see the reaction_guard table comment for why the buckets are
 * separate.
 */
export const REACTION_SEND_COST_MICROS = 1_000_000n;

/** Burst allowance: reactions that may land back-to-back (e.g. 👍 then 🎉). */
export const REACTION_BURST_SENDS = 5;

/**
 * Pure admission check for one reaction send: the shared send-rate token
 * bucket (see evaluateSendAllowance) at the reaction cost and burst. The
 * marker is persisted on the sender's reaction_guard row.
 */
export function evaluateReactionSend(request: SendAllowanceRequest): SendAllowanceVerdict {
  return evaluateSendAllowance(request, REACTION_SEND_COST_MICROS, REACTION_BURST_SENDS);
}
