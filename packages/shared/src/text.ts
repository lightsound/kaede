/** Why a piece of user-entered text was refused. */
export type TextRejectReason = 'empty' | 'too-long' | 'forbidden-characters';

export type NormalizedTextVerdict =
  | {
      ok: true;
      /** The normalized text to persist and render. */
      text: string;
    }
  | { ok: false; reason: TextRejectReason };

/** Whitespace runs (including tabs/newlines pasted in) collapse to one space. */
const WHITESPACE_RUN = /\s+/gu;

/**
 * Anything in Unicode category C (control, format, unassigned, surrogate,
 * private use) after whitespace collapsing. These render as nothing or as
 * tofu, and controls could smuggle direction overrides into other players'
 * screens. This also refuses ZWJ emoji sequences — an accepted trade-off for
 * text that every platform renders the same way.
 */
const FORBIDDEN = /\p{C}/u;

/**
 * Validates and normalizes one line of user-entered text — the shared core
 * behind display names and chat messages, which differ only in their length
 * cap. Pure and shared so the server reducers stay thin wrappers (module
 * code cannot be unit-tested) while the client reuses the exact same rules
 * for instant feedback.
 *
 * Normalization: Unicode NFC (so text composed with IME combining marks
 * equals its precomposed form), whitespace runs collapsed to single spaces,
 * then trimmed. Verdicts are on the normalized text, so " 楓 " is fine while
 * "  " is `empty`. `maxCodePoints` counts Unicode code points, not UTF-16
 * units, so Japanese text is not penalised by surrogate pairs.
 */
export function normalizeSingleLineText(raw: string, maxCodePoints: number): NormalizedTextVerdict {
  const text = raw.normalize('NFC').replace(WHITESPACE_RUN, ' ').trim();
  if (text.length === 0) return { ok: false, reason: 'empty' };
  if (FORBIDDEN.test(text)) return { ok: false, reason: 'forbidden-characters' };
  if ([...text].length > maxCodePoints) return { ok: false, reason: 'too-long' };
  return { ok: true, text };
}
