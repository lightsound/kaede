import { normalizeSingleLineText, type TextRejectReason } from './text';

/**
 * Longest allowed display name, counted in Unicode code points so Japanese
 * text is not penalised by UTF-16 surrogate pairs. Sixteen covers full
 * Japanese names with room to spare while keeping labels readable above a
 * 30px-wide avatar.
 */
export const DISPLAY_NAME_MAX_LENGTH = 16;

/** Why a proposed display name was refused. */
export type DisplayNameRejectReason = TextRejectReason;

export type DisplayNameVerdict =
  | {
      ok: true;
      /** The normalized name to persist and render. */
      name: string;
    }
  | { ok: false; reason: DisplayNameRejectReason };

/**
 * Validates and normalizes a proposed display name: the shared
 * single-line-text rules (NFC, whitespace collapsing, category-C rejection
 * — see normalizeSingleLineText) with the name-sized length cap. Pure and
 * shared so the server reducer stays a thin wrapper (module code cannot be
 * unit-tested) while the client reuses the exact same rules for instant
 * feedback.
 */
export function normalizeDisplayName(raw: string): DisplayNameVerdict {
  const verdict = normalizeSingleLineText(raw, DISPLAY_NAME_MAX_LENGTH);
  return verdict.ok ? { ok: true, name: verdict.text } : verdict;
}

/**
 * Why a rename request was refused: a bad name, or `no-target` when the
 * rename would land nowhere — the sender has no account (guests never do)
 * and no player_name row (never joined, or the row was swept along with
 * its player row).
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
  hasNameRow: boolean;
}): RenameVerdict {
  if (!request.hasAccount && !request.hasNameRow) return { ok: false, reason: 'no-target' };
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
  /** The name on the player_name row being resumed, when one survived. */
  resumedRowName: string | undefined;
  /** Hex form of the joining identity, seeding the default name. */
  identityHex: string;
}): string {
  return (
    source.persistedName ?? source.resumedRowName ?? `Player-${source.identityHex.slice(0, 6)}`
  );
}
