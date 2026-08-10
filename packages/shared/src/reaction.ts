/**
 * The overhead gestures (ROADMAP Phase 2 / Phase 5 ①c): the emoji-reaction
 * palette and the avatar pose gestures (座る・寝る・ダンス・手を振る) —
 * fixed vocabularies with exact-match validation, display rules, and send
 * rate limits. All pure and shared — the chat.ts precedent — so the server
 * reducers stay thin untestable wrappers, the client's buttons can only
 * ever offer what the server accepts, and the e2e specs can time their
 * polls off the same display constants (shared is the one workspace they
 * may import). The gesture vocabulary lives HERE rather than in a file of
 * its own deliberately: a new shared module whose public signatures
 * reference sendAllowance types would add type-coupling evidence edges,
 * and the budget sits at fallow's cap (the 増分③ zone.ts precedent).
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

/**
 * The fixed pose-gesture vocabulary (Phase 5 ①c). Senders pick from these;
 * the server refuses anything else by exact string match (isGestureKind —
 * the reaction-palette rule), so the public gesture table only ever holds
 * poses the avatar sheets can draw. The empty string is NOT a member: it
 * is play_gesture's explicit clear operation (standing up without moving),
 * validated separately.
 */
export const GESTURES = ['sit', 'sleep', 'dance', 'wave'] as const;

export type GestureKind = (typeof GESTURES)[number];

/** Whether `value` is exactly one of the gestures (the send validation). */
export function isGestureKind(value: string): value is GestureKind {
  return GESTURES.some((gesture) => gesture === value);
}

/** The Japanese wording of each gesture, shared by the UI buttons. */
export const GESTURE_LABELS: Record<GestureKind, string> = {
  sit: '座る',
  sleep: '寝る',
  dance: 'ダンス',
  wave: '手を振る',
};

/**
 * Whether a gesture is a passing greeting rather than a state. The display
 * convention forks on this (the reaction-vs-status split, decided in the
 * ①c schema review): STATE gestures (sit / sleep / dance) render from the
 * subscription seed as well as row events — someone sitting must still be
 * sitting after your reload — while a TRANSIENT gesture (wave) renders
 * from row events only, for WAVE_GESTURE_DURATION_MS: replaying a seeded
 * wave row would greet people who were not there when it happened. The
 * fork lives in this vocabulary, deliberately not in the schema: the row
 * shape stays one upsert row either way.
 */
export function isTransientGesture(gesture: GestureKind): boolean {
  return gesture === 'wave';
}

/** How long a wave plays after its row event (ms) — the reaction-window idea. */
export const WAVE_GESTURE_DURATION_MS = 4_000;

/**
 * How long each dance frame shows (ms). The adopted dance cycle is 8
 * frames over 0.8s (the ①c bench's wan clip sampled every 3rd frame at
 * 30fps), so this is both the extraction stride and the playback clock —
 * one constant so they cannot drift.
 */
export const DANCE_FRAME_MS = 100;

/**
 * Sustained send cost: one gesture per this many microseconds (1回/秒),
 * with a burst of GESTURE_BURST_SENDS — the reaction numbers, for the
 * reaction reasons (a gesture write is a public-row broadcast; refused
 * sends are never charged). Charged against a bucket of its own
 * (gesture_guard), so posing never eats into chat, reactions or status
 * (the reaction_guard separation rule). The server-side wrapper stays a
 * local function there (the 増分③ rate-wrapper rule) — only the numbers
 * are shared.
 */
export const GESTURE_SEND_COST_MICROS = 1_000_000n;

/** Burst allowance: gestures that may land back-to-back (sit, stand, wave…). */
export const GESTURE_BURST_SENDS = 5;
