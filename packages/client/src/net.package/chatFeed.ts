// fallow-ignore-file coverage-gaps -- wires live SpacetimeDB row events to the chat log and bubbles; needs a running host. The log operations it applies are pure and unit-tested (chatLog.ts), as are the mention rules it feeds candidates to (planChatDraft in @maple/shared)
import { collectDmCandidates, type DmCandidate } from '@maple/shared';
import type { DbConnection } from '../module_bindings';
import { type ChatEntryView, type ChatLog, insertChatEntry, removeChatEntry } from './chatLog';
import type { RowOf } from './rows';

/** The generated chat_message row type. */
type ChatMessageRow = RowOf<'chatMessage'>;

/** The generated dm_message row type. */
type DmMessageRow = RowOf<'dmMessage'>;

/** What acting on chat and DM rows needs from the session that wires the feed. */
interface ChatFeedHooks {
  /** True once this session's events must be ignored (see wireSession). */
  isStale(): boolean;
  showLocalBubble(text: string): void;
  showRemoteBubble(idHex: string, text: string): void;
  /**
   * Called once per dm_message row this session is handed — the seed and
   * every insert event alike. The E2E privacy probe: on a third party's
   * client this must never fire, and only counting what actually crossed
   * the wire can prove that (a display-layer filter could hide a leaked
   * row from the DOM without this count moving).
   */
  countDmRow(): void;
}

/**
 * Everyone a DM mention can resolve to right now, read at submit time from
 * the subscribed cache — so no state has to stream to the UI as people
 * come and go. This is only the cache projection; the eligibility rule
 * (in the world, online, named) is the pure collectDmCandidates,
 * unit-tested in @maple/shared — deliberately not the player_name table
 * alone, whose rows linger for the retention window (~10 minutes) after
 * their owner leaves.
 */
export function dmCandidatesOf(c: DbConnection): readonly DmCandidate[] {
  return collectDmCandidates(
    [...c.db.player.iter()].map((row) => ({
      online: row.online,
      name: c.db.playerName.identity.find(row.identity)?.name,
      key: row.identity.toHexString(),
    })),
  );
}

/**
 * The chat feed: owns the merged chat+DM log across sessions (the
 * wireAdmission / createRemoteViews shape — a factory for the state that
 * outlives a connection, a `wire` per session) and publishes it whole on
 * every change (the SpaceView precedent: one value, so the panel can never
 * render a half-applied update). The log survives a disconnect deliberately
 * — stale history beats a blanked panel — and the next session's seed
 * replaces it with the authoritative retained rows.
 */
export function createChatFeed(onChat: (log: ChatLog) => void) {
  let log: ChatLog = [];
  function publish(next: ChatLog): void {
    log = next;
    onChat(log);
  }

  return {
    /**
     * Wires one session: seed the log from the subscribed caches (row-level
     * security means the dm_message cache holds only this client's own
     * conversations), then keep it fed by row events. Display conventions
     * differ by kind:
     * - Public messages put a speech bubble over the speaker, from insert
     *   EVENTS only — the seed is history, and a reload must not replay a
     *   burst of bubbles.
     * - DMs never bubble, seed or event: a bubble is how public speech is
     *   seen by the room, and floating a DM over an avatar would make it
     *   read as something everyone else can see. The log line (with its
     *   recipient marker) is the whole display, so unlike bubbles it also
     *   restores from the seed on reload — DM history is state, not a
     *   gesture.
     */
    wire(c: DbConnection, myIdHex: string, hooks: ChatFeedHooks): void {
      const chatView = (row: ChatMessageRow): ChatEntryView => ({
        kind: 'chat',
        id: row.id,
        sentAtMicros: row.sentAt.microsSinceUnixEpoch,
        senderName: row.senderName,
        text: row.text,
        own: row.sender.toHexString() === myIdHex,
      });
      const dmView = (row: DmMessageRow): ChatEntryView => ({
        kind: 'dm',
        id: row.id,
        sentAtMicros: row.sentAt.microsSinceUnixEpoch,
        senderName: row.senderName,
        recipientName: row.recipientName,
        text: row.text,
        own: row.sender.toHexString() === myIdHex,
      });

      let seeded: ChatLog = [];
      for (const row of c.db.chatMessage.iter()) {
        seeded = insertChatEntry(seeded, chatView(row));
      }
      for (const row of c.db.dmMessage.iter()) {
        hooks.countDmRow();
        seeded = insertChatEntry(seeded, dmView(row));
      }
      publish(seeded);

      c.db.chatMessage.onInsert((_ctx, row) => {
        if (hooks.isStale()) return;
        publish(insertChatEntry(log, chatView(row)));
        // The bubble shows over whoever spoke: our own avatar, or the
        // sender's remote view. A message from a player whose view is not
        // on screen (hidden as offline, or already removed) is a no-op.
        const idHex = row.sender.toHexString();
        if (idHex === myIdHex) hooks.showLocalBubble(row.text);
        else hooks.showRemoteBubble(idHex, row.text);
      });
      c.db.dmMessage.onInsert((_ctx, row) => {
        if (hooks.isStale()) return;
        hooks.countDmRow();
        publish(insertChatEntry(log, dmView(row)));
      });
      // Retention trims (each history table keeps only its newest cap of
      // rows) arrive as deletes; the panel drops the line the moment the
      // authority does.
      c.db.chatMessage.onDelete((_ctx, row) => {
        if (hooks.isStale()) return;
        publish(removeChatEntry(log, 'chat', row.id));
      });
      c.db.dmMessage.onDelete((_ctx, row) => {
        if (hooks.isStale()) return;
        publish(removeChatEntry(log, 'dm', row.id));
      });
    },
  };
}
