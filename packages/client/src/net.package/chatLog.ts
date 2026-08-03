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
  /** The row's autoInc id: send order WITHIN its kind, half of the key. */
  readonly id: bigint;
  /** Server send time (micros): the merged log's ordering. */
  readonly sentAtMicros: bigint;
  /** The sender's display name, snapshotted at send time. */
  readonly senderName: string;
  /** The normalized message text. */
  readonly text: string;
  /** True when this client sent it (own-message styling). */
  readonly own: boolean;
}

/** One public chat message as the UI renders it. */
export interface PublicChatEntry extends ChatEntryBase {
  readonly kind: 'chat';
}

/** One DM as the UI renders it — only its sender and recipient ever hold one. */
export interface DmChatEntry extends ChatEntryBase {
  readonly kind: 'dm';
  /** The recipient's display name, snapshotted at send time. */
  readonly recipientName: string;
}

export type ChatEntryView = PublicChatEntry | DmChatEntry;

/** The whole log, ascending by send order. */
export type ChatLog = readonly ChatEntryView[];

/** The entry's identity across both tables — the React list key. */
export function chatEntryKey(entry: Pick<ChatEntryView, 'kind' | 'id'>): string {
  return `${entry.kind}:${entry.id}`;
}

/** Send order: sentAt, then the (kind, id) key as a deterministic tiebreak. */
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

/** The log without the `(kind, id)` entry, for the server's retention deletes. */
export function removeChatEntry(log: ChatLog, kind: ChatEntryView['kind'], id: bigint): ChatLog {
  return log.filter((m) => !(m.kind === kind && m.id === id));
}
