/**
 * The client-side chat log: an ordered, immutable view of the subscribed
 * chat_message rows, published to the UI as one value (the SpaceView
 * precedent). Pure so the ordering and trim behavior are unit-tested; the
 * row events feeding it live in sync.ts.
 */

/** One chat message as the UI renders it. */
export interface ChatMessageView {
  /** The row's autoInc id: send order, and the React list key. */
  readonly id: bigint;
  /** The sender's display name, snapshotted at send time (see chat_message). */
  readonly senderName: string;
  /** The normalized message text. */
  readonly text: string;
  /** True when this client sent it (own-message styling). */
  readonly own: boolean;
}

/** The whole log, ascending by id (= send order). */
export type ChatLog = readonly ChatMessageView[];

/**
 * The log with `message` added in id order. Row events normally arrive in
 * commit order, but the initial seed iterates an unordered cache, so every
 * insertion finds its place rather than trusting arrival order. A duplicate
 * id leaves the log unchanged (insurance against an event racing the seed).
 */
export function insertChatMessage(log: ChatLog, message: ChatMessageView): ChatLog {
  if (log.some((m) => m.id === message.id)) return log;
  const at = log.findIndex((m) => m.id > message.id);
  if (at === -1) return [...log, message];
  return [...log.slice(0, at), message, ...log.slice(at)];
}

/** The log without the message `id`, for the server's retention deletes. */
export function removeChatMessage(log: ChatLog, id: bigint): ChatLog {
  return log.filter((m) => m.id !== id);
}
