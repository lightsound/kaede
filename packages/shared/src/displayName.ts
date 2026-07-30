/**
 * Longest allowed display name, counted in Unicode code points so Japanese
 * text is not penalised by UTF-16 surrogate pairs. Sixteen covers full
 * Japanese names with room to spare while keeping labels readable above a
 * 30px-wide avatar.
 */
export const DISPLAY_NAME_MAX_LENGTH = 16;

/** Why a proposed display name was refused. */
export type DisplayNameRejectReason = 'empty' | 'too-long' | 'forbidden-characters';

export type DisplayNameVerdict =
  | {
      ok: true;
      /** The normalized name to persist and render. */
      name: string;
    }
  | { ok: false; reason: DisplayNameRejectReason };

/** Whitespace runs (including tabs/newlines pasted in) collapse to one space. */
const WHITESPACE_RUN = /\s+/gu;

/**
 * Anything in Unicode category C (control, format, unassigned, surrogate,
 * private use) after whitespace collapsing. These render as nothing or as
 * tofu, and controls could smuggle direction overrides into other players'
 * screens. This also refuses ZWJ emoji sequences — an accepted trade-off for
 * a name that every platform renders the same way.
 */
const FORBIDDEN = /\p{C}/u;

/**
 * Validates and normalizes a proposed display name. Pure and shared so the
 * server reducer stays a thin wrapper (module code cannot be unit-tested)
 * while the client reuses the exact same rules for instant feedback.
 *
 * Normalization: Unicode NFC (so a name composed with IME combining marks
 * equals its precomposed form), whitespace runs collapsed to single spaces,
 * then trimmed. Verdicts are on the normalized text, so " 楓 " is fine while
 * "  " is `empty`.
 */
export function normalizeDisplayName(raw: string): DisplayNameVerdict {
  const name = raw.normalize('NFC').replace(WHITESPACE_RUN, ' ').trim();
  if (name.length === 0) return { ok: false, reason: 'empty' };
  if (FORBIDDEN.test(name)) return { ok: false, reason: 'forbidden-characters' };
  if ([...name].length > DISPLAY_NAME_MAX_LENGTH) return { ok: false, reason: 'too-long' };
  return { ok: true, name };
}
