import { Identity } from 'spacetimedb';
import { describe, expect, it } from 'vite-plus/test';
import { sessionRows } from '../src/net.package/rowEvents';
import {
  cachedZoneTag,
  type HuddleView,
  type ZoneAdminView,
  wireZones,
} from '../src/net.package/zoneFeed';
import type { RowOf } from '../src/net.package/rows';
type ConversationGroup = RowOf<'conversationGroup'>;
type GroupMember = RowOf<'groupMember'>;
type Player = RowOf<'player'>;
import { at, fakeConnection, fakeTable } from './fakeDb';

const ME = new Identity(1n);
const OTHER = new Identity(2n);

const groupRow = (
  id: bigint,
  kind: string,
  name: string,
  over: Partial<ConversationGroup> = {},
): ConversationGroup => ({
  id,
  kind,
  name,
  closed: false,
  mapId: 0,
  x: 0,
  y: 0,
  w: 10,
  h: 10,
  ...over,
});

const memberRow = (identity: Identity, groupId: bigint): GroupMember => ({ identity, groupId });

const playerRow = (identity: Identity, x: number, y: number): Player => ({
  identity,
  x,
  y,
  vx: 0,
  vy: 0,
  facing: 1,
  onGround: true,
  rope: 0,
  tick: 0,
  online: true,
  updatedAt: at(0),
  mapId: 0,
});

function harness(currentMapId = 0) {
  const conversationGroup = fakeTable<ConversationGroup>({ id: (row) => row.id });
  const groupMember = fakeTable<GroupMember>({ identity: (row) => row.identity });
  const player = fakeTable<Player>({ identity: (row) => row.identity });
  const conn = fakeConnection({ conversationGroup, groupMember, player });
  const rows = sessionRows(ME.toHexString(), () => false);
  const calls: string[] = [];
  const huddles: HuddleView[] = [];
  const adminViews: ZoneAdminView[][] = [];
  const hooks = {
    currentMapId: () => currentMapId,
    setMapZones: (zones: readonly { key: string; label: string }[]) =>
      calls.push(`zones ${zones.map((zone) => `${zone.key}:${zone.label}`).join(',')}`),
    setMapHuddles: (
      list: readonly {
        key: string;
        label: string;
        includesLocal: boolean;
        memberIds: readonly string[];
      }[],
    ) =>
      calls.push(
        `huddles ${list.map((h) => `${h.key}:${h.label}:${h.includesLocal ? 'local' : 'remote'}:${h.memberIds.join('+')}`).join(',')}`,
      ),
    applyOwnZone: (tag: string | undefined) => calls.push(`own tag ${tag ?? 'none'}`),
    applyRemoteZone: (idHex: string, tag: string | undefined) =>
      calls.push(`remote ${idHex} tag ${tag ?? 'none'}`),
    onZones: (zones: ZoneAdminView[]) => adminViews.push(zones),
    onHuddle: (view: HuddleView) => huddles.push(view),
  };
  return { conversationGroup, groupMember, player, conn, rows, hooks, calls, huddles, adminViews };
}

describe('cachedZoneTag', () => {
  it('composes the tag from the membership and its group, by kind', () => {
    const h = harness();
    h.conversationGroup.seed([groupRow(1n, 'zone', '会議室'), groupRow(2n, 'huddle', '雑談')]);
    h.groupMember.seed([memberRow(ME, 1n), memberRow(OTHER, 2n)]);
    expect(cachedZoneTag(h.conn, ME)).toBe('📍 会議室');
    expect(cachedZoneTag(h.conn, OTHER)).toBe('💬 雑談');
    expect(cachedZoneTag(h.conn, new Identity(3n))).toBeUndefined();
  });
});

describe('wireZones', () => {
  it('projects the current map’s zones at wiring, and the admin view across maps', () => {
    const h = harness(0);
    h.conversationGroup.seed([
      groupRow(1n, 'zone', '会議室'),
      groupRow(2n, 'zone', '別マップ', { mapId: 1 }),
      groupRow(3n, 'zone', '立入禁止', { closed: true }),
    ]);
    wireZones(h.conn, h.rows, ME, h.hooks);
    expect(h.calls).toContain('zones 1:会議室,3:🔒 立入禁止');
    expect(h.adminViews.at(-1)!.map((zone) => `${zone.key}:${zone.mapName}`)).toEqual([
      '1:広場',
      '2:会議フロア',
      '3:広場',
    ]);
  });

  it('re-projects layer, admin view and tags when a group row changes', () => {
    const h = harness();
    h.conversationGroup.seed([groupRow(1n, 'zone', '会議室')]);
    h.groupMember.seed([memberRow(OTHER, 1n)]);
    wireZones(h.conn, h.rows, ME, h.hooks);
    h.calls.length = 0;
    h.conversationGroup.update(groupRow(1n, 'zone', '大会議室'));
    expect(h.calls).toContain('zones 1:大会議室');
    expect(h.calls).toContain(`remote ${OTHER.toHexString()} tag 📍 大会議室`);
  });

  it('applies tags from membership events and clears them on delete', () => {
    const h = harness();
    h.conversationGroup.seed([groupRow(1n, 'zone', '会議室')]);
    wireZones(h.conn, h.rows, ME, h.hooks);
    h.calls.length = 0;
    h.groupMember.insert(memberRow(ME, 1n));
    h.groupMember.remove(memberRow(ME, 1n));
    expect(h.calls.filter((call) => call.startsWith('own tag'))).toEqual([
      'own tag 📍 会議室',
      'own tag none',
    ]);
  });

  it('projects the huddle layer: local/remote split, current map only, kept fresh', () => {
    const h = harness(0);
    h.conversationGroup.seed([
      groupRow(2n, 'huddle', '雑談'),
      groupRow(3n, 'huddle', '別マップ', { mapId: 1 }),
    ]);
    h.groupMember.seed([memberRow(ME, 2n), memberRow(OTHER, 2n), memberRow(new Identity(3n), 3n)]);
    wireZones(h.conn, h.rows, ME, h.hooks);
    expect(h.calls).toContain(`huddles 2:💬 雑談:local:${OTHER.toHexString()}`);
    h.groupMember.remove(memberRow(OTHER, 2n));
    expect(h.calls).toContain('huddles 2:💬 雑談:local:');
  });

  it('publishes the own huddle as the control’s answer while a member', () => {
    const h = harness();
    h.conversationGroup.seed([groupRow(2n, 'huddle', '雑談')]);
    h.groupMember.seed([memberRow(ME, 2n)]);
    wireZones(h.conn, h.rows, ME, h.hooks);
    expect(h.huddles.at(-1)).toEqual({ own: '💬 雑談', joinable: undefined });
  });

  it('offers the joinable huddle when standing by its members, deduplicated', () => {
    const h = harness();
    h.conversationGroup.seed([groupRow(2n, 'huddle', '雑談')]);
    h.groupMember.seed([memberRow(OTHER, 2n)]);
    h.player.seed([playerRow(ME, 100, 100), playerRow(OTHER, 100, 100)]);
    wireZones(h.conn, h.rows, ME, h.hooks);
    expect(h.huddles).toEqual([{ own: undefined, joinable: { id: 2n, label: '💬 雑談' } }]);
    h.player.update(playerRow(OTHER, 100, 100));
    expect(h.huddles).toHaveLength(1);
  });
});
