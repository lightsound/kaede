// fallow-ignore-file coverage-gaps -- wires live SpacetimeDB row events to the chat log and bubbles; needs a running host. The log operations it applies are pure and unit-tested (chatLog.ts), as are the scope rules it composes labels with (chat.ts in @kaede/shared)
import {
  CHAT_SCOPE_MAP,
  chatScopeTag,
  type DmRowEvent,
  type DmRowSource,
  mapFor,
} from '@kaede/shared';
import type { DbConnection } from '../module_bindings';
import { type ChatEntryView, type ChatLog, insertChatEntry, removeChatEntry } from './chatLog';
import type { RowOf } from './rows';

/** The generated chat_message row type. */
type ChatMessageRow = RowOf<'chatMessage'>;

/**
 * The scope marker for one chat row, resolved against the cache at the
 * moment the row is taken in (ROADMAP Phase 3 増分④): the map's display
 * name comes from the shared map table, the group's from its
 * conversation_group row. Both are read ONCE per row rather than per
 * render — a later rename leaves old lines saying what the group was
 * called when they arrived, the same reading senderName already has.
 * The composition itself is the shared chatScopeTag, so the panel, the
 * scope selector and the E2E specs all name a scope identically.
 */
function scopeTagOf(c: DbConnection, row: ChatMessageRow): string | undefined {
  return chatScopeTag({
    scope: row.scope,
    announcement: row.announcement,
    mapName: row.scope === CHAT_SCOPE_MAP ? mapFor(Number(row.target)).name : undefined,
    groupName: c.db.conversationGroup.id.find(row.target)?.name,
  });
}

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
   * every insert event alike, source-tagged. Two consumers ride it (see
   * sync.ts): the E2E privacy counter (on a third party's client this
   * must never fire, and only counting what actually crossed the wire can
   * prove that — a display-layer filter could hide a leaked row from the
   * DOM without the count moving) and the browser-notification pipeline.
   * The seed passes through on purpose: the notification rule
   * (shouldNotifyDm) refuses seed rows, and feeding it the seed keeps that
   * refusal an executed, E2E-probeable rule instead of a wiring accident.
   */
  onDmRow(event: DmRowEvent): void;
  /**
   * Called once per chat_message row this session is handed — the seed and
   * every insert event alike, tagged with the row's raw scope. The E2E
   * scope-privacy counter rides it (sync.ts): a closed group's line missing
   * from a non-member's DOM would also be true of a display-layer filter,
   * so the spec asserts on what actually crossed the wire (the dmRowsReceived
   * precedent).
   */
  onChatRow(scope: string): void;
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
        scopeTag: scopeTagOf(c, row),
        announcement: row.announcement,
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
      const dmEvent = (row: DmMessageRow, source: DmRowSource): DmRowEvent => {
        const senderKey = row.sender.toHexString();
        return {
          source,
          own: senderKey === myIdHex,
          senderName: row.senderName,
          senderKey,
          text: row.text,
        };
      };

      let seeded: ChatLog = [];
      for (const row of c.db.chatMessage.iter()) {
        hooks.onChatRow(row.scope);
        seeded = insertChatEntry(seeded, chatView(row));
      }
      for (const row of c.db.dmMessage.iter()) {
        hooks.onDmRow(dmEvent(row, 'seed'));
        seeded = insertChatEntry(seeded, dmView(row));
      }
      publish(seeded);

      c.db.chatMessage.onInsert((_ctx, row) => {
        if (hooks.isStale()) return;
        hooks.onChatRow(row.scope);
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
        hooks.onDmRow(dmEvent(row, 'event'));
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
