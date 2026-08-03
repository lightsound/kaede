import { describe, expect, it } from 'vitest';
import {
  type ChatEntryView,
  chatEntryKey,
  insertChatEntry,
  removeChatEntry,
} from '../src/net.package/chatLog';

function chat(id: bigint, sentAtMicros = id * 10n, text = `msg-${id}`): ChatEntryView {
  return { kind: 'chat', id, sentAtMicros, senderName: '楓', text, own: false };
}

function dm(id: bigint, sentAtMicros = id * 10n, text = `dm-${id}`): ChatEntryView {
  return {
    kind: 'dm',
    id,
    sentAtMicros,
    senderName: '楓',
    recipientName: 'もみじ',
    text,
    own: false,
  };
}

describe('chatEntryKey', () => {
  // The two tables' autoInc sequences are independent, so a chat row and a
  // DM row may carry the same id; the key must keep them apart.
  it('distinguishes a chat entry from a DM entry with the same id', () => {
    expect(chatEntryKey(chat(7n))).not.toBe(chatEntryKey(dm(7n)));
  });
});

describe('insertChatEntry', () => {
  it('appends entries arriving in send order', () => {
    let log = insertChatEntry([], chat(1n));
    log = insertChatEntry(log, chat(2n));
    expect(log.map(chatEntryKey)).toEqual(['chat:1', 'chat:2']);
  });

  // The initial seed iterates two unordered row caches.
  it('places an out-of-order entry by send time', () => {
    let log = insertChatEntry([], chat(3n));
    log = insertChatEntry(log, chat(1n));
    log = insertChatEntry(log, chat(2n));
    expect(log.map(chatEntryKey)).toEqual(['chat:1', 'chat:2', 'chat:3']);
  });

  it('interleaves chat and DM entries by send time, not by id', () => {
    let log = insertChatEntry([], chat(50n, 100n));
    log = insertChatEntry(log, dm(1n, 200n));
    log = insertChatEntry(log, chat(51n, 300n));
    log = insertChatEntry(log, dm(2n, 150n));
    expect(log.map(chatEntryKey)).toEqual(['chat:50', 'dm:2', 'dm:1', 'chat:51']);
  });

  // Reducer timestamps have microsecond resolution; an exact tie must
  // still order deterministically (kind, then id).
  it('breaks a send-time tie by kind then id', () => {
    let log = insertChatEntry([], dm(2n, 100n));
    log = insertChatEntry(log, chat(9n, 100n));
    log = insertChatEntry(log, dm(1n, 100n));
    expect(log.map(chatEntryKey)).toEqual(['chat:9', 'dm:1', 'dm:2']);
  });

  it('ignores a duplicate (kind, id)', () => {
    const log = insertChatEntry([], chat(1n, 10n, 'first'));
    expect(insertChatEntry(log, chat(1n, 20n, 'second'))).toBe(log);
  });

  it('keeps a DM alongside a chat entry with the same id', () => {
    const log = insertChatEntry([], chat(1n));
    expect(insertChatEntry(log, dm(1n)).map(chatEntryKey)).toEqual(['chat:1', 'dm:1']);
  });

  it('does not mutate the input log', () => {
    const log = insertChatEntry([], chat(1n));
    insertChatEntry(log, chat(2n));
    expect(log.map(chatEntryKey)).toEqual(['chat:1']);
  });
});

describe('removeChatEntry', () => {
  it('drops the trimmed entry and keeps the rest in order', () => {
    let log = insertChatEntry([], chat(1n));
    log = insertChatEntry(log, chat(2n));
    log = insertChatEntry(log, chat(3n));
    expect(removeChatEntry(log, 'chat', 2n).map(chatEntryKey)).toEqual(['chat:1', 'chat:3']);
  });

  // The retention delete for a dm_message row must not take out the
  // public message that happens to carry the same id.
  it('removes only the matching kind', () => {
    let log = insertChatEntry([], chat(1n));
    log = insertChatEntry(log, dm(1n));
    expect(removeChatEntry(log, 'dm', 1n).map(chatEntryKey)).toEqual(['chat:1']);
  });

  it('leaves the log as-is for an unknown id', () => {
    const log = insertChatEntry([], chat(1n));
    expect(removeChatEntry(log, 'chat', 9n)).toEqual(log);
  });
});
