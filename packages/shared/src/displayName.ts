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

/**
 * Why a rename request was refused: a bad name, or `no-target` when the
 * rename would land nowhere — the sender has no account (guests never do)
 * and no player row (never joined, or the row was swept).
 */
export type RenameRejectReason = DisplayNameRejectReason | 'no-target';

export type RenameVerdict = { ok: true; name: string } | { ok: false; reason: RenameRejectReason };

/**
 * Pure admission check for one rename request, shared so the server reducer
 * stays a thin wrapper and the rule itself is unit-testable (the
 * evaluateInputBatch precedent). A rename that would update neither the
 * account nor the player row must fail loudly instead of reporting success
 * while the name evaporates; either target alone is fine — a member whose
 * row was swept still deserves its account update.
 */
export function evaluateRename(request: {
  rawName: string;
  hasAccount: boolean;
  hasPlayerRow: boolean;
}): RenameVerdict {
  if (!request.hasAccount && !request.hasPlayerRow) return { ok: false, reason: 'no-target' };
  return normalizeDisplayName(request.rawName);
}

/**
 * The display name a joining player spawns under: the account's persisted
 * name when one is set, else the name the (resumed) row already carries, else
 * a default derived from the identity. Pure, so the precedence — a rename
 * made on another device must win over a lingering row on this one — is
 * unit-tested in shared rather than buried in the join reducer. Named fields
 * rather than positional parameters: two adjacent optional strings would let
 * a swapped call site invert exactly the precedence this function protects.
 */
export function resolveJoinName(source: {
  /** The account's display name, when the member has set one. */
  persistedName: string | undefined;
  /** The name on the player row being resumed, when one survived. */
  resumedRowName: string | undefined;
  /** Hex form of the joining identity, seeding the default name. */
  identityHex: string;
}): string {
  return (
    source.persistedName ?? source.resumedRowName ?? `Player-${source.identityHex.slice(0, 6)}`
  );
}
