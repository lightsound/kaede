import { Identity } from 'spacetimedb';
import { describe, expect, it } from 'vite-plus/test';
import { type ChatScopeView, wireChatScopes } from '../src/net.package/chatScopeFeed';
import { sessionRows } from '../src/net.package/rowEvents';
import type { RowOf } from '../src/net.package/rows';
type ConversationGroup = RowOf<'conversationGroup'>;
type GroupMember = RowOf<'groupMember'>;
type Player = RowOf<'player'>;
import { at, fakeConnection, fakeTable } from './fakeDb';

const ME = new Identity(1n);

const playerRow = (mapId: number): Player => ({
  identity: ME,
  x: 0,
  y: 0,
  vx: 0,
  vy: 0,
  facing: 1,
  onGround: true,
  rope: 0,
  tick: 0,
  online: true,
  updatedAt: at(0),
  mapId,
});

const groupRow = (id: bigint, name: string): ConversationGroup => ({
  id,
  kind: 'huddle',
  name,
  closed: false,
  mapId: 0,
  x: 0,
  y: 0,
  w: 10,
  h: 10,
});

function harness() {
  const player = fakeTable<Player>({ identity: (row) => row.identity });
  const groupMember = fakeTable<GroupMember>({ identity: (row) => row.identity });
  const conversationGroup = fakeTable<ConversationGroup>({ id: (row) => row.id });
  const conn = fakeConnection({ player, groupMember, conversationGroup });
  const rows = sessionRows(ME.toHexString(), () => false);
  const published: ChatScopeView[] = [];
  const hooks = { onChatScopes: (view: ChatScopeView) => published.push(view) };
  return { player, groupMember, conversationGroup, conn, rows, hooks, published };
}

const scopesOf = (view: ChatScopeView) => view.map((option) => `${option.scope}:${option.label}`);

describe('wireChatScopes', () => {
  it('offers space and the default map while there is no own row', () => {
    const { conn, rows, hooks, published } = harness();
    wireChatScopes(conn, rows, ME, hooks);
    expect(published.map(scopesOf)).toEqual([['space:全体', 'map:広場']]);
  });

  it('adds the group scope while a member, named by its group row', () => {
    const { groupMember, conversationGroup, conn, rows, hooks, published } = harness();
    conversationGroup.seed([groupRow(5n, 'もくもく会')]);
    wireChatScopes(conn, rows, ME, hooks);
    groupMember.insert({ identity: ME, groupId: 5n });
    groupMember.remove({ identity: ME, groupId: 5n });
    expect(published.map(scopesOf)).toEqual([
      ['space:全体', 'map:広場'],
      ['space:全体', 'map:広場', 'group:もくもく会'],
      ['space:全体', 'map:広場'],
    ]);
  });

  it('deduplicates by value: a row event that changes no label publishes nothing', () => {
    const { player, conn, rows, hooks, published } = harness();
    wireChatScopes(conn, rows, ME, hooks);
    player.insert(playerRow(0)); // own row lands, still the default map
    player.update(playerRow(0));
    expect(published).toHaveLength(1);
  });

  it('renames the group scope when the group row renames', () => {
    const { groupMember, conversationGroup, conn, rows, hooks, published } = harness();
    conversationGroup.seed([groupRow(5n, '旧名')]);
    groupMember.seed([{ identity: ME, groupId: 5n }]);
    wireChatScopes(conn, rows, ME, hooks);
    conversationGroup.update(groupRow(5n, '新名'));
    expect(published.map(scopesOf).at(-1)).toEqual(['space:全体', 'map:広場', 'group:新名']);
  });
});
