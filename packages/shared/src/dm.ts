/**
 * The @mention DM (ROADMAP Phase 2): how a chat draft is classified as a
 * public message or a DM, how the mentioned name resolves to a recipient,
 * and the DM history retention cap. All pure and shared (the
 * normalizeChatText precedent) so the rules are unit-tested here; with the
 * client-resolves-the-recipient argument design (see send_dm in the server's
 * posting.ts) only the client executes them, but they still must not be
 * hand-rolled twice — the server re-validates the RESOLVED recipient
 * (existence, in-world, online), not the parse.
 */

import { normalizeChatText } from './chat';
import type { TextRejectReason } from './text';

/**
 * One person a DM could resolve to: a display name as rendered right now,
 * and the opaque identity key (hex) a send would target. The caller builds
 * the list from who is IN THE WORLD AND ONLINE — never from mere
 * player_name rows, which outlive their owner by the retention window
 * (~10 minutes), so a name row's existence does not mean its holder can be
 * seen or addressed.
 */
export interface DmCandidate {
  readonly name: string;
  readonly key: string;
}

/** One in-world player as the candidate rule reads it (see collectDmCandidates). */
export interface DmCandidateSource {
  /** The player row's online flag — an offline row lingers unrendered. */
  readonly online: boolean;
  /** The current display name; undefined when the name row is missing. */
  readonly name: string | undefined;
  /** Opaque identity key (hex). */
  readonly key: string;
}

/**
 * The candidate-eligibility half of the resolution rule: a mention can
 * resolve to a player who is in the world (a player row exists), online
 * (not a lingering retention-window row nobody renders), and named (a
 * nameless row is the mid-teardown broken-pair case; nothing renders it,
 * so nothing can mention it). Pure over row projections so the rule is
 * unit-tested here; the client feeds it its subscribed cache. The own
 * player passes like anyone else — a self-DM is a memo.
 */
export function collectDmCandidates(players: Iterable<DmCandidateSource>): DmCandidate[] {
  const candidates: DmCandidate[] = [];
  for (const player of players) {
    if (!player.online || player.name === undefined || player.name === '') continue;
    candidates.push({ name: player.name, key: player.key });
  }
  return candidates;
}

/**
 * Why a draft classified as a DM was refused. `no-recipient` covers both a
 * mention matching nobody and a plain message that merely starts with '@'
 * — by design the two cannot be told apart, and neither may fall back to
 * the public chat (the leak this feature must never allow). `ambiguous`
 * refuses a name held by several people rather than picking one: display
 * names are not unique, and a misdelivered DM is a disclosure.
 */
export type DmRejectReason = 'dm-no-recipient' | 'dm-ambiguous-recipient' | 'dm-empty-body';

export type ChatDraftRejectReason = TextRejectReason | DmRejectReason;

/**
 * What one chat submit should do. `refused` carries every reason a draft
 * can fail client-side — text rules and DM resolution alike — so the one
 * verdict drives the whole submit path and a DM can never leak into the
 * public branch by falling through.
 */
export type ChatDraftPlan =
  | { kind: 'public'; text: string }
  | { kind: 'dm'; recipientKey: string; recipientName: string; text: string }
  | { kind: 'refused'; reason: ChatDraftRejectReason };

/**
 * A plan the submit path may dispatch — everything but the refused arm,
 * which never leaves the form. What the send callback receives, so the
 * kind-dispatch (public reducer vs DM reducer) lives with the reducer
 * calls instead of branching in the presentation layer.
 */
export type PlannedSend = Exclude<ChatDraftPlan, { kind: 'refused' }>;

/**
 * Classifies one chat draft: a message whose NORMALIZED text starts with
 * '@' is a DM attempt, everything else is public. The whole draft goes
 * through normalizeChatText first, so a DM body inherits the exact rules a
 * public message obeys (NFC, whitespace collapsing, category-C rejection,
 * the 200-code-point cap counted over mention plus body).
 *
 * Mention syntax: `@名前 本文`. Display names may contain spaces and even
 * '@' (normalizeSingleLineText refuses only category C), so "where the
 * name ends" is decided by matching against `candidates`, not by
 * delimiters: the LONGEST candidate name that follows the '@' and is
 * terminated by a space (or the end of the draft) wins. Longest-match
 * makes the parse deterministic when one name prefixes another ("楓" /
 * "楓さん"); the cost — you cannot DM 楓 a body that begins with さん —
 * is taken over any escaping syntax. A draft starting with '@' that
 * matches nobody is REFUSED, never posted publicly: silently publishing
 * text its author addressed to one person is the accident this rule
 * exists to prevent, and it also means there is no way to publicly post a
 * message starting with '@' (accepted; the error message says so).
 */
export function planChatDraft(raw: string, candidates: readonly DmCandidate[]): ChatDraftPlan {
  const verdict = normalizeChatText(raw);
  if (!verdict.ok) return { kind: 'refused', reason: verdict.reason };
  if (!verdict.text.startsWith('@')) return { kind: 'public', text: verdict.text };
  return planDm(verdict.text.slice(1), candidates);
}

/** Resolves the mention half of a '@'-leading draft (see planChatDraft). */
function planDm(rest: string, candidates: readonly DmCandidate[]): ChatDraftPlan {
  const holders = mentionHolders(rest, candidates);
  const recipient = holders[0];
  if (recipient === undefined) return { kind: 'refused', reason: 'dm-no-recipient' };
  // Two or more people currently hold the mentioned name; delivering to a
  // deterministic "first" one would leak the message to whichever the
  // sender did not mean.
  if (holders.length > 1) return { kind: 'refused', reason: 'dm-ambiguous-recipient' };
  if (rest.length === recipient.name.length) return { kind: 'refused', reason: 'dm-empty-body' };
  return {
    kind: 'dm',
    recipientKey: recipient.key,
    recipientName: recipient.name,
    // Past "name + space"; already normalized (whitespace runs collapsed,
    // ends trimmed), so no leading/trailing space can survive here.
    text: rest.slice(recipient.name.length + 1),
  };
}

/**
 * Every candidate holding the LONGEST name the mention text starts with
 * (terminated by a space or the end of the text); empty when nothing
 * matches. Two DIFFERENT names of equal length cannot both prefix the same
 * text, so the longest matching name is unique and the returned candidates
 * all share it — several entries mean several people hold that one name.
 */
function mentionHolders(rest: string, candidates: readonly DmCandidate[]): DmCandidate[] {
  let holders: DmCandidate[] = [];
  for (const candidate of candidates) {
    if (rest !== candidate.name && !rest.startsWith(`${candidate.name} `)) continue;
    const held = holders[0];
    if (held === undefined || candidate.name.length > held.name.length) holders = [candidate];
    else if (candidate.name === held.name) holders.push(candidate);
  }
  return holders;
}

/**
 * How many DM rows the space keeps, across all conversations (保持方針 —
 * one global cap, the CHAT_HISTORY_MAX shape, NOT a per-pair cap). What the
 * cap bounds differs from the public chat: row-level security means a
 * client's entry egress covers only its own conversations, but STORAGE is
 * billed on the whole table — and guest identities are per-tab, so pairs
 * are unbounded and a per-pair cap would grow storage without limit. A
 * global cap also expires dead pairs' rows (both tabs closed) by plain
 * displacement, with no sweep tied to player lifecycle — DM history must
 * outlive the player rows (the chat_message precedent), so removePlayer
 * deliberately never touches it. Double the public cap because every
 * conversation shares this one budget.
 */
export const DM_HISTORY_MAX = 200;
