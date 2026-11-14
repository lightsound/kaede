import { mapFor } from '@kaede/shared';
import { Identity } from 'spacetimedb';
import { describe, expect, it } from 'vite-plus/test';
import type { Connected } from '../src/net.package/connection';
import { createPlayerFeed, type OwnSim, type PlayerFeedDeps } from '../src/net.package/playerFeed';
import { sessionRows } from '../src/net.package/rowEvents';
import type { RowOf } from '../src/net.package/rows';
type ConversationGroup = RowOf<'conversationGroup'>;
type Gesture = RowOf<'gesture'>;
type GroupMember = RowOf<'groupMember'>;
type Player = RowOf<'player'>;
type PlayerName = RowOf<'playerName'>;
type PlayerStatus = RowOf<'playerStatus'>;
import { at, fakeConnection, fakeTable } from './fakeDb';

const ME = new Identity(1n);
const OTHER = new Identity(2n);

const playerRow = (identity: Identity, over: Partial<Player> = {}): Player => ({
  identity,
  x: 10,
  y: 20,
  vx: 0,
  vy: 0,
  facing: 1,
  onGround: true,
  rope: 0,
  tick: 3,
  online: true,
  updatedAt: at(5000),
  mapId: 0,
  ...over,
});

function harness() {
  const player = fakeTable<Player>({ identity: (row) => row.identity });
  const playerName = fakeTable<PlayerName>({ identity: (row) => row.identity });
  const playerStatus = fakeTable<PlayerStatus>({ identity: (row) => row.identity });
  const gesture = fakeTable<Gesture>({ identity: (row) => row.identity });
  const groupMember = fakeTable<GroupMember>({ identity: (row) => row.identity });
  const conversationGroup = fakeTable<ConversationGroup>({ id: (row) => row.id });
  const joins: unknown[] = [];
  const unsubscribed: string[] = [];
  let subCount = 0;
  const conn = fakeConnection({
    player,
    playerName,
    playerStatus,
    gesture,
    groupMember,
    conversationGroup,
  });
  // The surface beyond `db` the feed touches: the join reducer and the
  // subscription builder switchMap swaps map subscriptions through.
  const raw = conn as unknown as {
    reducers: unknown;
    subscriptionBuilder: unknown;
  };
  raw.reducers = {
    join: (args: unknown) => {
      joins.push(args);
      return Promise.resolve();
    },
  };
  // The fake fires onApplied synchronously inside subscribe(); the real
  // SDK fires it asynchronously once the subscription applies. The feed
  // tests below pin the wiring (which handle gets dropped), not timing.
  raw.subscriptionBuilder = () => {
    let applied: (() => void) | undefined;
    const builder = {
      onApplied: (callback: () => void) => {
        applied = callback;
        return builder;
      },
      subscribe: () => {
        subCount += 1;
        const name = `sub${subCount}`;
        applied?.();
        return {
          unsubscribe: () => unsubscribed.push(name),
        };
      },
    };
    return builder;
  };
  const outgoing = {
    unsubscribe: () => unsubscribed.push('initial'),
  };
  const settled = {
    conn,
    myIdentity: ME,
    myIdHex: ME.toHexString(),
    mapId: 0,
    mapSub: outgoing,
  } as unknown as Connected;
  const rows = sessionRows(ME.toHexString(), () => false);

  const calls: string[] = [];
  const gameApp = {
    patchLocalLabel: (label: unknown) => calls.push(`patchLocalLabel ${JSON.stringify(label)}`),
    start: () => calls.push('game start'),
    stop: () => calls.push('game stop'),
    resetLocal: () => calls.push('game resetLocal'),
    clearRemotePlayers: () => calls.push('game clearRemotePlayers'),
    removeRemotePlayer: (idHex: string) => calls.push(`game removeRemotePlayer ${idHex}`),
    setMap: (map: { id: number }) => calls.push(`game setMap ${map.id}`),
  };
  const remoteViews = {
    record: (
      idHex: string,
      label: {
        name: string;
        status: string | undefined;
        zone: string | undefined;
        gesture: string | undefined;
        availability: string;
      },
    ) =>
      calls.push(
        `views record ${idHex} ${label.name}|${label.status ?? 'none'}|${label.zone ?? 'none'}|${label.gesture ?? 'none'}|${label.availability}`,
      ),
    remove: (idHex: string) => calls.push(`views remove ${idHex}`),
    clear: () => calls.push('views clear'),
    patchLabel: (idHex: string, patch: { name?: string }) =>
      calls.push(`views patchLabel ${idHex} ${patch.name ?? ''}`),
  };
  const sim: OwnSim = { prediction: undefined, currentMapId: 0, portalPendingAtMs: undefined };
  let heartbeats = 0;
  let rowUpdates = 0;
  let zoneRefreshes = 0;
  const deps = {
    sim,
    gameApp,
    remoteViews,
    publishOwnName: (name: string | undefined) => calls.push(`ownName ${name ?? 'none'}`),
    publishOwnStatus: (view: { availability: string; text: string }) =>
      calls.push(`ownStatus ${view.availability}:${view.text}`),
    sendHeartbeat: () => {
      heartbeats += 1;
    },
    sendBatch: () => {},
    countRowUpdate: () => {
      rowUpdates += 1;
    },
    refreshZones: () => {
      zoneRefreshes += 1;
    },
  } as unknown as PlayerFeedDeps;
  const feed = createPlayerFeed(settled, rows, deps);
  return {
    player,
    playerName,
    playerStatus,
    gesture,
    groupMember,
    conversationGroup,
    feed,
    sim,
    calls,
    joins,
    unsubscribed,
    heartbeats: () => heartbeats,
    rowUpdates: () => rowUpdates,
    zoneRefreshes: () => zoneRefreshes,
  };
}

describe('createPlayerFeed.enterWorld', () => {
  it('asks the server to spawn when there is no surviving own row', () => {
    const h = harness();
    h.feed.enterWorld();
    expect(h.joins).toHaveLength(1);
    expect(h.calls).toEqual([]);
    expect(h.sim.prediction).toBeUndefined();
  });

  it('resumes a surviving own row: seeds name, status and heartbeat, starts the game', () => {
    const h = harness();
    h.playerName.seed([{ identity: ME, name: 'わたし', online: true }]);
    h.playerStatus.seed([{ identity: ME, availability: 'busy', text: '集中' }]);
    h.gesture.seed([{ identity: ME, gesture: 'sit', sentAt: at(1000) }]);
    h.player.seed([playerRow(ME)]);
    h.feed.enterWorld();
    expect(h.joins).toHaveLength(0);
    expect(h.calls).toContain('ownName わたし');
    expect(h.calls).toContain('ownStatus busy:集中');
    expect(h.calls).toContain('patchLocalLabel {"gesture":"sit"}');
    expect(h.calls).toContain('game start');
    expect(h.heartbeats()).toBe(1);
    expect(h.sim.prediction).toBeDefined();
    // Idempotent: a second admission pass must not restart the simulation.
    h.calls.length = 0;
    h.feed.enterWorld();
    expect(h.calls).toEqual([]);
  });
});

describe('createPlayerFeed.seedRemotes', () => {
  it('records online same-map remotes and removes offline or other-map rows', () => {
    const h = harness();
    const third = new Identity(3n);
    const fourth = new Identity(4n);
    h.playerName.seed([
      { identity: OTHER, name: 'あいて', online: true },
      { identity: third, name: 'さん', online: true },
      { identity: fourth, name: 'よん', online: true },
    ]);
    h.player.seed([
      playerRow(ME),
      playerRow(OTHER),
      playerRow(third, { online: false }),
      playerRow(fourth, { mapId: 1 }),
    ]);
    h.feed.seedRemotes();
    expect(h.calls).toContain(`views record ${OTHER.toHexString()} あいて|none|none|none|online`);
    expect(h.calls).toContain(`views remove ${third.toHexString()}`);
    expect(h.calls).toContain(`views remove ${fourth.toHexString()}`);
    expect(h.calls.some((call) => call.includes(ME.toHexString()))).toBe(false);
  });

  it('seeds a recreated view with the cached status, zone tag and pose', () => {
    const h = harness();
    h.playerName.seed([{ identity: OTHER, name: 'さん', online: true }]);
    h.playerStatus.seed([{ identity: OTHER, availability: 'busy', text: '集中' }]);
    h.gesture.seed([{ identity: OTHER, gesture: 'sit', sentAt: at(1000) }]);
    h.conversationGroup.seed([
      {
        id: 1n,
        kind: 'zone',
        name: '会議室',
        closed: false,
        mapId: 0,
        x: 0,
        y: 0,
        w: 10,
        h: 10,
      },
    ]);
    h.groupMember.seed([{ identity: OTHER, groupId: 1n }]);
    h.player.seed([playerRow(OTHER)]);
    h.feed.seedRemotes();
    expect(h.calls).toContain(
      `views record ${OTHER.toHexString()} さん|🔴 取り込み中・集中|📍 会議室|sit|busy`,
    );
  });
});

describe('createPlayerFeed.wireRowEvents', () => {
  it('routes player inserts: own starts the sim, remote is recorded, both counted', () => {
    const h = harness();
    let reevaluates = 0;
    h.feed.wireRowEvents({
      reevaluate: () => {
        reevaluates += 1;
      },
    });
    h.player.insert(playerRow(OTHER));
    h.player.insert(playerRow(ME));
    expect(h.rowUpdates()).toBe(2);
    expect(h.calls).toContain(`views record ${OTHER.toHexString()} |none|none|none|online`);
    expect(h.calls).toContain('game start');
    expect(reevaluates).toBe(0);
  });

  it('re-announces liveness when the own row flips offline mid-session', () => {
    const h = harness();
    h.player.seed([playerRow(ME)]);
    h.feed.enterWorld();
    h.feed.wireRowEvents({ reevaluate: () => {} });
    expect(h.heartbeats()).toBe(1);
    h.player.update(playerRow(ME, { online: false }));
    expect(h.heartbeats()).toBe(2);
  });

  it('switches maps on an own-row map flip: scene, views, zones and subscription swap', () => {
    const h = harness();
    h.player.seed([playerRow(ME)]);
    h.feed.enterWorld();
    h.feed.wireRowEvents({ reevaluate: () => {} });
    const predictionBefore = h.sim.prediction;
    h.sim.portalPendingAtMs = 1234;
    h.calls.length = 0;
    h.player.update(playerRow(ME, { mapId: 1 }));
    expect(h.sim.currentMapId).toBe(1);
    expect(h.sim.portalPendingAtMs).toBeUndefined();
    expect(h.calls).toContain('views clear');
    expect(h.calls).toContain('game clearRemotePlayers');
    expect(h.calls).toContain(`game setMap ${mapFor(1).id}`);
    expect(h.zoneRefreshes()).toBe(1);
    expect(h.unsubscribed).toEqual(['initial']);
    expect(h.calls).toContain('game start');
    // The prediction is rebuilt for the destination map, not carried over.
    expect(h.sim.prediction).toBeDefined();
    expect(h.sim.prediction).not.toBe(predictionBefore);
    // The swapped-in subscription is the stored one: switching back drops
    // IT (sub1), not the long-gone initial handle a second time.
    h.player.update(playerRow(ME, { mapId: 0 }));
    expect(h.sim.currentMapId).toBe(0);
    expect(h.unsubscribed).toEqual(['initial', 'sub1']);
  });

  it('tears the sim down when the own row is deleted and re-runs admission', () => {
    const h = harness();
    h.player.seed([playerRow(ME)]);
    h.feed.enterWorld();
    let reevaluates = 0;
    h.feed.wireRowEvents({
      reevaluate: () => {
        reevaluates += 1;
      },
    });
    h.player.remove(playerRow(ME));
    expect(h.sim.prediction).toBeUndefined();
    expect(h.calls).toContain('game stop');
    expect(h.calls).toContain('ownName none');
    expect(reevaluates).toBe(1);
  });

  it('removes a remote view when its row is deleted', () => {
    const h = harness();
    h.feed.wireRowEvents({ reevaluate: () => {} });
    h.player.insert(playerRow(OTHER));
    h.player.remove(playerRow(OTHER));
    expect(h.calls).toContain(`views remove ${OTHER.toHexString()}`);
    expect(h.calls).toContain(`game removeRemotePlayer ${OTHER.toHexString()}`);
  });

  it('routes player_name changes: own publishes, remote patches the label', () => {
    const h = harness();
    h.feed.wireRowEvents({ reevaluate: () => {} });
    h.playerName.insert({ identity: ME, name: '新しい名前', online: true });
    h.playerName.insert({ identity: OTHER, name: '相手の旧名', online: true });
    h.playerName.update({ identity: OTHER, name: '相手の新名', online: true });
    expect(h.calls).toContain('ownName 新しい名前');
    expect(h.calls).toContain(`views patchLabel ${OTHER.toHexString()} 相手の旧名`);
    expect(h.calls).toContain(`views patchLabel ${OTHER.toHexString()} 相手の新名`);
  });
});
