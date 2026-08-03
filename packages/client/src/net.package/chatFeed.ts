// fallow-ignore-file coverage-gaps -- wires live SpacetimeDB row events to the chat log and bubbles; needs a running host. The log operations it applies are pure and unit-tested (chatLog.ts)
import type { DbConnection } from '../module_bindings';
import {
  type ChatLog,
  type ChatMessageView,
  insertChatMessage,
  removeChatMessage,
} from './chatLog';

/** The generated chat_message row type (the bindings don't re-export it). */
type ChatMessageRow =
  ReturnType<DbConnection['db']['chatMessage']['iter']> extends Iterator<infer R> ? R : never;

/** What acting on chat rows needs from the session that wires the feed. */
interface ChatFeedHooks {
  /** True once this session's events must be ignored (see wireSession). */
  isStale(): boolean;
  showLocalBubble(text: string): void;
  showRemoteBubble(idHex: string, text: string): void;
}

/**
 * The chat feed: owns the log across sessions (the wireAdmission /
 * createRemoteViews shape — a factory for the state that outlives a
 * connection, a `wire` per session) and publishes it whole on every change
 * (the SpaceView precedent: one value, so the panel can never render a
 * half-applied update). The log survives a disconnect deliberately — stale
 * history beats a blanked panel — and the next session's seed replaces it
 * with the authoritative retained rows.
 */
export function createChatFeed(onChat: (log: ChatLog) => void) {
  let log: ChatLog = [];
  function publish(next: ChatLog): void {
    log = next;
    onChat(log);
  }

  return {
    /**
     * Wires one session: seed the log from the subscribed cache, then keep
     * it (and the speech bubbles) fed by row events. Bubbles come only
     * from the insert EVENTS, never from the seed: the seed is history (a
     * reload must not replay a burst of bubbles), an event is someone
     * speaking now.
     */
    wire(c: DbConnection, myIdHex: string, hooks: ChatFeedHooks): void {
      const toView = (row: ChatMessageRow): ChatMessageView => ({
        id: row.id,
        senderName: row.senderName,
        text: row.text,
        own: row.sender.toHexString() === myIdHex,
      });

      let seeded: ChatLog = [];
      for (const row of c.db.chatMessage.iter()) {
        seeded = insertChatMessage(seeded, toView(row));
      }
      publish(seeded);

      c.db.chatMessage.onInsert((_ctx, row) => {
        if (hooks.isStale()) return;
        publish(insertChatMessage(log, toView(row)));
        // The bubble shows over whoever spoke: our own avatar, or the
        // sender's remote view. A message from a player whose view is not
        // on screen (hidden as offline, or already removed) is a no-op.
        const idHex = row.sender.toHexString();
        if (idHex === myIdHex) hooks.showLocalBubble(row.text);
        else hooks.showRemoteBubble(idHex, row.text);
      });
      // Retention trims (the server keeps only the newest CHAT_HISTORY_MAX
      // rows) arrive as deletes; the panel drops the line the moment the
      // authority does.
      c.db.chatMessage.onDelete((_ctx, row) => {
        if (hooks.isStale()) return;
        publish(removeChatMessage(log, row.id));
      });
    },
  };
}
