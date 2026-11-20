/**
 * The client-side chat log: one ordered, immutable view over the subscribed
 * chat_message AND dm_message rows, published to the UI as one value (the
 * SpaceView precedent). Pure so the ordering, dedup and trim behavior are
 * unit-tested; the row events feeding it live in chatFeed.ts.
 *
 * The two tables' autoInc ids are INDEPENDENT sequences, so an id alone can
 * neither order the merged log nor identify an entry (a chat row and a DM
 * row may both be id 7). Identity is the (kind, id) pair — chatEntryKey —
 * and order is send time (`sentAt`, which reducers stamp in commit order)
 * with the pair as a deterministic tiebreak.
 */

/**
 * What every log entry carries; ChatEntryView discriminates on `kind`.
 * Exported (the ReactionFeedHooks precedent) because it appears in the
 * exported entry interfaces, which fallow's private-type-leaks rule
 * refuses for a private type.
 */
export interface ChatEntryBase {
  readonly id: bigint;
  readonly sentAtMicros: bigint;
  readonly senderName: string;
  readonly text: string;
  readonly own: boolean;
}

export interface PublicChatEntry extends ChatEntryBase {
  readonly kind: 'chat';
  /**
   * The line's scope marker (全体 / the map's name / the group's name /
   * アナウンス — chatScopeTag in @kaede/shared), composed when the row is
   * taken in. Undefined for a scope this build does not know, which renders
   * as a plain line rather than claiming a scope it cannot name.
   */
  readonly scopeTag: string | undefined;
  readonly announcement: boolean;
}

export interface DmChatEntry extends ChatEntryBase {
  readonly kind: 'dm';
  readonly recipientName: string;
}

export type ChatEntryView = PublicChatEntry | DmChatEntry;

export type ChatLog = readonly ChatEntryView[];

export function chatEntryKey(entry: Pick<ChatEntryView, 'kind' | 'id'>): string {
  return `${entry.kind}:${entry.id}`;
}

function compareEntries(a: ChatEntryView, b: ChatEntryView): number {
  if (a.sentAtMicros !== b.sentAtMicros) return a.sentAtMicros < b.sentAtMicros ? -1 : 1;
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The log with `entry` added in send order. Row events normally arrive in
 * commit order, but the initial seed iterates two unordered caches, so every
 * insertion finds its place rather than trusting arrival order. A duplicate
 * (kind, id) leaves the log unchanged (insurance against an event racing
 * the seed).
 */
export function insertChatEntry(log: ChatLog, entry: ChatEntryView): ChatLog {
  if (log.some((m) => m.kind === entry.kind && m.id === entry.id)) return log;
  const at = log.findIndex((m) => compareEntries(m, entry) > 0);
  if (at === -1) return [...log, entry];
  return [...log.slice(0, at), entry, ...log.slice(at)];
}

export function removeChatEntry(log: ChatLog, kind: ChatEntryView['kind'], id: bigint): ChatLog {
  return log.filter((m) => !(m.kind === kind && m.id === id));
}
