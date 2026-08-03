import { describe, expect, it } from 'vitest';
import {
  type ChatMessageView,
  insertChatMessage,
  removeChatMessage,
} from '../src/net.package/chatLog';

function message(id: bigint, text = `msg-${id}`): ChatMessageView {
  return { id, senderName: '楓', text, own: false };
}

describe('insertChatMessage', () => {
  it('appends messages arriving in send order', () => {
    let log = insertChatMessage([], message(1n));
    log = insertChatMessage(log, message(2n));
    expect(log.map((m) => m.id)).toEqual([1n, 2n]);
  });

  // The initial seed iterates an unordered row cache.
  it('places an out-of-order message by id', () => {
    let log = insertChatMessage([], message(3n));
    log = insertChatMessage(log, message(1n));
    log = insertChatMessage(log, message(2n));
    expect(log.map((m) => m.id)).toEqual([1n, 2n, 3n]);
  });

  it('ignores a duplicate id', () => {
    const log = insertChatMessage([], message(1n, 'first'));
    expect(insertChatMessage(log, message(1n, 'second'))).toBe(log);
  });

  it('does not mutate the input log', () => {
    const log = insertChatMessage([], message(1n));
    insertChatMessage(log, message(2n));
    expect(log.map((m) => m.id)).toEqual([1n]);
  });
});

describe('removeChatMessage', () => {
  it('drops the trimmed message and keeps the rest in order', () => {
    let log = insertChatMessage([], message(1n));
    log = insertChatMessage(log, message(2n));
    log = insertChatMessage(log, message(3n));
    expect(removeChatMessage(log, 2n).map((m) => m.id)).toEqual([1n, 3n]);
  });

  it('leaves the log as-is for an unknown id', () => {
    const log = insertChatMessage([], message(1n));
    expect(removeChatMessage(log, 9n)).toEqual(log);
  });
});
