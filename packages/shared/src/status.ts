/**
 * The manual player status (ROADMAP Phase 2): the three-state availability
 * switch (オンライン/離席/取り込み中), the free-text status line, and the
 * send rate limit. All pure and shared — the chat.ts / reaction.ts
 * precedent — so the server reducers stay thin untestable wrappers, the
 * client's controls can only ever offer what the server accepts, and the
 * e2e specs assert on the same composed label the canvas renders.
 *
 * "Availability" rather than "presence" on purpose: presence already means
 * connection liveness in this codebase (player.online, the idle guard),
 * and this switch is the player's own claim about themselves, orthogonal
 * to whether their socket is up.
 */

import {
  evaluateSendAllowance,
  type SendAllowanceRequest,
  type SendAllowanceVerdict,
} from './sendAllowance';
import { normalizeSingleLineText, type TextRejectReason } from './text';

/**
 * The fixed availability vocabulary. Senders pick from these; the server
 * refuses anything else by exact string match (isAvailability, the
 * reaction-palette precedent), so free-form strings never reach the public
 * player_status table through this column.
 */
export const AVAILABILITIES = ['online', 'away', 'busy'] as const;

export type Availability = (typeof AVAILABILITIES)[number];

/** Whether `value` is exactly one of the availabilities (the send validation). */
export function isAvailability(value: string): value is Availability {
  return AVAILABILITIES.some((availability) => availability === value);
}

/** The Japanese wording of each availability, shared by the UI buttons and the canvas label. */
export const AVAILABILITY_LABELS: Record<Availability, string> = {
  online: 'オンライン',
  away: '離席',
  busy: '取り込み中',
};

/** The presence dot rendered before the label — the classic traffic-light triad. */
export const AVAILABILITY_ICONS: Record<Availability, string> = {
  online: '🟢',
  away: '🟡',
  busy: '🔴',
};

/**
 * One player's status as clients act on it: the availability plus the
 * free-text line ('' while unset). The shape a missing player_status row
 * defaults to is DEFAULT_STATUS (the guestsAllowedFrom precedent).
 */
export interface StatusView {
  availability: Availability;
  text: string;
}

/** What a missing player_status row means: online, nothing to say. */
export const DEFAULT_STATUS: StatusView = { availability: 'online', text: '' };

/**
 * Narrows a raw player_status row (or its absence) to a StatusView — the
 * client-side boundary for rows this module cannot vouch for (the
 * isReactionEmoji narrowing precedent). A row carrying an availability
 * outside the vocabulary reads as the default rather than rendering an
 * unvetted string; a missing row IS the default (no row is ever inserted
 * for it). Accepts `null` so both SDKs' `find` results pass through.
 */
export function statusViewOf(
  row: { availability: string; text: string } | null | undefined,
): StatusView {
  if (!row || !isAvailability(row.availability)) return DEFAULT_STATUS;
  return { availability: row.availability, text: row.text };
}

/**
 * Longest allowed free-text status, in Unicode code points. Twice the
 * display-name cap: the label renders under the avatar on the canvas, so it
 * must stay a glanceable line, not a paragraph — 32 covers the intended
 * texture (「もくもく作業中・話しかけてOK」 is 15) with room to spare, and
 * anything longer belongs in chat.
 */
export const STATUS_TEXT_MAX_LENGTH = 32;

/** Why a free-text status was refused. Never 'empty': an empty text means "clear". */
export type StatusTextRejectReason = Exclude<TextRejectReason, 'empty'>;

export type StatusTextVerdict =
  | {
      ok: true;
      /** The normalized text to persist and render; '' clears the status line. */
      text: string;
    }
  | { ok: false; reason: StatusTextRejectReason };

/**
 * Validates and normalizes one free-text status: the display-name rules
 * (NFC, whitespace collapsing, category-C rejection — see
 * normalizeSingleLineText) with the status-sized cap, except that an empty
 * or whitespace-only input is ACCEPTED as '' — a status is a state, so
 * "set it to nothing" is the clear operation, not a mistake to refuse
 * (unlike a chat message or a name, which must say something).
 */
export function normalizeStatusText(raw: string): StatusTextVerdict {
  const verdict = normalizeSingleLineText(raw, STATUS_TEXT_MAX_LENGTH);
  if (verdict.ok) return verdict;
  const { reason } = verdict;
  if (reason === 'empty') return { ok: true, text: '' };
  return { ok: false, reason };
}

/**
 * The one line the canvas renders under the avatar, or undefined while the
 * status is the default (nothing to show). Composed here — not in the
 * renderer — so the e2e specs and both player views (own and remote)
 * assert on and render exactly the same string:
 * - away/busy without text: the dot and the word (「🔴 取り込み中」)
 * - away/busy with text: both, joined by ・ (「🔴 取り込み中・もくもく作業中」)
 * - online with text: the dot and the text (the word オンライン says nothing
 *   the dot doesn't)
 */
export function statusLabel(view: StatusView): string | undefined {
  if (view.availability === 'online') {
    return view.text === '' ? undefined : `${AVAILABILITY_ICONS.online} ${view.text}`;
  }
  const base = `${AVAILABILITY_ICONS[view.availability]} ${AVAILABILITY_LABELS[view.availability]}`;
  return view.text === '' ? base : `${base}・${view.text}`;
}

/**
 * Sustained send cost: one status write per this many microseconds (1回/秒),
 * with a burst of STATUS_BURST_SENDS. Honest usage is a few writes per DAY,
 * so the same numbers as chat are far above anything a person does — the
 * bucket exists because a status write is a public-row broadcast to every
 * subscriber, and refused sends are never charged, so without it an
 * in-world client could loop set_availability into unbounded egress.
 * Charged against a bucket of its own (status_guard), so setting a status
 * never eats into the sender's chat or reaction allowance (see the
 * reaction_guard table comment for why the buckets stay separate).
 */
export const STATUS_SEND_COST_MICROS = 1_000_000n;

/** Burst allowance: writes that may land back-to-back (e.g. 取り込み中 then the text). */
export const STATUS_BURST_SENDS = 5;

/**
 * Pure admission check for one status write: the shared send-rate token
 * bucket (see evaluateSendAllowance) at the status cost and burst. The
 * marker is persisted on the sender's status_guard row.
 */
export function evaluateStatusSend(request: SendAllowanceRequest): SendAllowanceVerdict {
  return evaluateSendAllowance(request, STATUS_SEND_COST_MICROS, STATUS_BURST_SENDS);
}
