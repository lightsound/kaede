import { Identity } from 'spacetimedb';
import { describe, expect, it } from 'vite-plus/test';
import { createChatFeed } from '../src/net.package/chatFeed';
import type { ChatLog } from '../src/net.package/chatLog';
import { sessionRows } from '../src/net.package/rowEvents';
import type { RowOf } from '../src/net.package/rows';
type ChatMessage = RowOf<'chatMessage'>;
type ConversationGroup = RowOf<'conversationGroup'>;
type DmMessage = RowOf<'dmMessage'>;
import { at, fakeConnection, fakeTable } from './fakeDb';

const ME = new Identity(1n);
const OTHER = new Identity(2n);

const chatRow = (
  id: bigint,
  sender: Identity,
  text: string,
  sentAtMs = 1000,
  scope = 'space',
  target = 0n,
): ChatMessage => ({
  id,
  sender,
  senderName: sender.isEqual(ME) ? 'わたし' : 'あいて',
  text,
  sentAt: at(sentAtMs),
  scope,
  target,
  announcement: false,
});

const dmRow = (id: bigint, sender: Identity, text: string, sentAtMs = 1000): DmMessage => ({
  id,
  sender,
  recipient: sender.isEqual(ME) ? OTHER : ME,
  senderName: sender.isEqual(ME) ? 'わたし' : 'あいて',
  recipientName: sender.isEqual(ME) ? 'あいて' : 'わたし',
  text,
  sentAt: at(sentAtMs),
});

function harness() {
  const chatMessage = fakeTable<ChatMessage>({ id: (row) => row.id });
  const dmMessage = fakeTable<DmMessage>({ id: (row) => row.id });
  const conversationGroup = fakeTable<ConversationGroup>({ id: (row) => row.id });
  const conn = fakeConnection({ chatMessage, dmMessage, conversationGroup });
  const rows = sessionRows(ME.toHexString(), () => false);
  const logs: ChatLog[] = [];
  const events: string[] = [];
  const hooks = {
    showLocalBubble: (text: string) => events.push(`bubble own ${text}`),
    showRemoteBubble: (idHex: string, text: string) => events.push(`bubble ${idHex} ${text}`),
    onDmRow: (event: { source: string; own: boolean; text: string }) =>
      events.push(`dm ${event.source} own=${event.own} ${event.text}`),
    onChatRow: (scope: string) => events.push(`chat-row ${scope}`),
  };
  const feed = createChatFeed((log) => logs.push(log));
  return { chatMessage, dmMessage, conversationGroup, conn, rows, hooks, feed, logs, events };
}

const lines = (log: ChatLog) => log.map((entry) => `${entry.kind}:${entry.text}`);

describe('createChatFeed.wire', () => {
  it('seeds the merged log once, reporting every seeded row to the counters', () => {
    const h = harness();
    h.chatMessage.seed([chatRow(1n, OTHER, 'おはよう', 1000)]);
    h.dmMessage.seed([dmRow(2n, OTHER, 'ひみつ', 2000)]);
    h.feed.wire(h.conn, h.rows, h.hooks);
    expect(h.logs).toHaveLength(1);
    expect(lines(h.logs[0])).toEqual(['chat:おはよう', 'dm:ひみつ']);
    expect(h.events).toEqual(['chat-row space', 'dm seed own=false ひみつ']);
  });

  it('shows a bubble for a chat insert event only, routed by sender', () => {
    const h = harness();
    h.feed.wire(h.conn, h.rows, h.hooks);
    h.chatMessage.insert(chatRow(1n, ME, 'やあ'));
    h.chatMessage.insert(chatRow(2n, OTHER, 'どうも'));
    expect(h.events).toEqual([
      'chat-row space',
      'bubble own やあ',
      'chat-row space',
      `bubble ${OTHER.toHexString()} どうも`,
    ]);
    expect(lines(h.logs.at(-1)!)).toEqual(['chat:やあ', 'chat:どうも']);
  });

  it('never bubbles a DM, seed or event, but logs both', () => {
    const h = harness();
    h.dmMessage.seed([dmRow(1n, OTHER, 'seed分')]);
    h.feed.wire(h.conn, h.rows, h.hooks);
    // The control: a public insert through the same wiring DOES bubble, so
    // the bubble hooks are live and the DM absence below cannot pass
    // vacuously (a dead events array would fail here first).
    h.chatMessage.insert(chatRow(1n, OTHER, '対照', 2000));
    h.dmMessage.insert(dmRow(2n, ME, '自分のDM', 3000));
    h.dmMessage.insert(dmRow(3n, OTHER, '相手のDM', 4000));
    expect(h.events.filter((event) => event.startsWith('bubble'))).toEqual([
      `bubble ${OTHER.toHexString()} 対照`,
    ]);
    expect(h.events).toEqual([
      'dm seed own=false seed分',
      'chat-row space',
      `bubble ${OTHER.toHexString()} 対照`,
      'dm event own=true 自分のDM',
      'dm event own=false 相手のDM',
    ]);
    expect(lines(h.logs.at(-1)!)).toEqual(['dm:seed分', 'chat:対照', 'dm:自分のDM', 'dm:相手のDM']);
  });

  it('drops a line when its row is deleted (the retention trim)', () => {
    const h = harness();
    h.feed.wire(h.conn, h.rows, h.hooks);
    h.chatMessage.insert(chatRow(1n, OTHER, '消える'));
    h.dmMessage.insert(dmRow(2n, OTHER, '消えるDM'));
    h.chatMessage.remove(chatRow(1n, OTHER, '消える'));
    h.dmMessage.remove(dmRow(2n, OTHER, '消えるDM'));
    expect(lines(h.logs.at(-1)!)).toEqual([]);
  });

  it('tags a group-scoped line with the group name read at intake', () => {
    const h = harness();
    h.conversationGroup.seed([
      {
        id: 5n,
        kind: 'huddle',
        name: 'もくもく会',
        closed: false,
        mapId: 0,
        x: 0,
        y: 0,
        w: 10,
        h: 10,
      },
    ]);
    h.feed.wire(h.conn, h.rows, h.hooks);
    h.chatMessage.insert(chatRow(1n, OTHER, 'グループ宛', 1000, 'group', 5n));
    const tags = h.logs
      .at(-1)!
      .map((entry) => (entry.kind === 'chat' ? entry.scopeTag : undefined));
    expect(tags).toEqual(['もくもく会']);
  });
});
