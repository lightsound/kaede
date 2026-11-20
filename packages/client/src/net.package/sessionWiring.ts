// fallow-ignore-file coverage-gaps -- wires every feed to one session's live DbConnection (the whole subscribed table surface at once); each feed is unit-tested against the fakeDb seam in packages/client/test, and this composition is covered end-to-end by e2e
import {
  CHAT_SCOPE_GROUP,
  type DmRowEvent,
  type E2ENetStats,
  mapFor,
  statusLabel,
} from '@kaede/shared';
import type { GameApp } from '../game.package';
import { type SpaceView, wireAdmission } from './admission';
import { wireOwnGroup } from './callFeed';
import { createChatFeed } from './chatFeed';
import { type ChatScopeView, wireChatScopes } from './chatScopeFeed';
import type { Connected } from './connection';
import { wireGestures } from './gestureFeed';
import type { InputSender } from './inputSender';
import type { OwnPublishers } from './ownPublishers';
import { createPlayerFeed, type OwnSim } from './playerFeed';
import { wireReactions } from './reactionFeed';
import { type RecordingLabelView, wireRecordings } from './recordingFeed';
import { createRemoteViews } from './remoteView';
import { sessionRows } from './rowEvents';
import { wireStatuses } from './statusFeed';
import { type HuddleView, wireZones, type ZoneAdminView } from './zoneFeed';

export interface SessionWiringDeps {
  gameApp: GameApp;
  remoteViews: ReturnType<typeof createRemoteViews>;
  chatFeed: ReturnType<typeof createChatFeed>;
  sim: OwnSim;
  publishers: OwnPublishers;
  inputSender: InputSender;
  bumpStat(key: keyof E2ENetStats): void;
  onSpace(view: SpaceView): void;
  onZones(zones: ZoneAdminView[]): void;
  onHuddle(view: HuddleView): void;
  onChatScopes(view: ChatScopeView): void;
  onOwnGroup(groupId: bigint | undefined): void;
  onRecordings(labels: RecordingLabelView[]): void;
  onDmRow(event: DmRowEvent): void;
  isStale(generation: number): boolean;
  clearConnection(): void;
}

export interface SessionWiring {
  wireSession(settled: Connected, generation: number): void;
  dropSession(): void;
}

export function createSessionWiring(deps: SessionWiringDeps): SessionWiring {
  const { gameApp, remoteViews, chatFeed, sim, publishers, inputSender } = deps;

  function dropSession(): void {
    sim.prediction = undefined;
    deps.clearConnection();
    sim.portalPendingAtMs = undefined;
    remoteViews.clear();
    gameApp.clearRemotePlayers();
    // Whether our row survives the retention window is unknowable while
    // offline; report it gone so the rename form disables until the row
    // (re)appears after the next join.
    publishers.publishOwnName(undefined);
  }

  function wireSession(settled: Connected, generation: number): void {
    const { conn: c, myIdentity, myIdHex } = settled;
    const stale = () => deps.isStale(generation);
    const rows = sessionRows(myIdHex, stale);

    // The whole-session map state: the shared currentMapId (the tick
    // callback reads it, and so does the zone feed's seed refresh below,
    // which is why this comes first), and the rendered map — set here
    // because a session may resume an identity that left off on another
    // map, or replace a session that did.
    sim.currentMapId = settled.mapId;
    sim.portalPendingAtMs = undefined;
    gameApp.setMap(mapFor(sim.currentMapId));

    wireStatuses(c, rows, {
      applyOwn: publishers.publishOwnStatus,
      applyRemote: (idHex, view) =>
        remoteViews.patchLabel(idHex, {
          status: statusLabel(view),
          availability: view.availability,
        }),
    });

    wireGestures(c, rows, {
      applyOwn: (gesture) => gameApp.patchLocalLabel({ gesture }),
      applyRemote: (idHex, gesture) => remoteViews.patchLabel(idHex, { gesture }),
      waveOwn: () => gameApp.showLocalWave(),
      waveRemote: (idHex) => gameApp.showRemoteWave(idHex),
    });

    // Zones (ROADMAP Phase 3 増分②): the rendered zone layer, the occupancy
    // tags and the admin panel's zone list — statuses' wiring shape, plus a
    // per-map projection the map switch (playerFeed.ts) re-pushes. Wired
    // before the admission block so its enterWorld (which may route through
    // switchMap) finds the feed ready.
    const zoneFeed = wireZones(c, rows, myIdentity, {
      currentMapId: () => sim.currentMapId,
      setMapZones: (zones) => gameApp.setZones(zones),
      setMapHuddles: (huddles) => gameApp.setHuddles(huddles),
      applyOwnZone: (tag) => gameApp.patchLocalLabel({ zone: tag }),
      applyRemoteZone: (idHex, tag) => remoteViews.patchLabel(idHex, { zone: tag }),
      onZones: deps.onZones,
      onHuddle: deps.onHuddle,
    });

    // The chat scope selector (ROADMAP Phase 3 増分④): which scopes this
    // client may address from where it stands — the zone feed's shape, over
    // the same rows (the own player row's map, the own membership) plus the
    // group rows' names. Its own feed rather than another branch of the
    // zone feed: the answer is about the chat panel, not about the zone
    // layer, and this file is long enough (see chatScopeFeed.ts).
    wireChatScopes(c, rows, myIdentity, { onChatScopes: deps.onChatScopes });

    wireOwnGroup(c, rows, myIdentity, { onOwnGroup: deps.onOwnGroup });

    wireRecordings(c, rows, { onRecordings: deps.onRecordings });

    // The RLS privacy probe for the call registry (the groupChatRowsReceived
    // idea): how many group_call rows — join capabilities — this connection
    // was actually handed. Insert events only; the seed is counted by the
    // cache enumeration below, so a reloaded client still reports what the
    // seed delivered.
    for (const _row of c.db.groupCall.iter()) deps.bumpStat('groupCallRowsReceived');
    rows.on(c.db.groupCall, { insert: () => deps.bumpStat('groupCallRowsReceived') });

    const players = createPlayerFeed(settled, rows, {
      sim,
      gameApp,
      remoteViews,
      publishOwnName: publishers.publishOwnName,
      publishOwnStatus: publishers.publishOwnStatus,
      sendHeartbeat: inputSender.sendHeartbeat,
      sendBatch: inputSender.sendBatch,
      countRowUpdate: () => deps.bumpStat('playerRowUpdates'),
      refreshZones: zoneFeed.refresh,
    });

    const admission = wireAdmission(c, rows, myIdentity, {
      onSpace: deps.onSpace,
      enterWorld: players.enterWorld,
    });

    players.seedRemotes();

    chatFeed.wire(c, rows, {
      showLocalBubble: (text) => gameApp.showLocalBubble(text),
      showRemoteBubble: (idHex, text) => gameApp.showRemoteBubble(idHex, text),
      onDmRow: (event) => {
        deps.bumpStat('dmRowsReceived');
        deps.onDmRow(event);
      },
      onChatRow: (scope) => {
        if (scope === CHAT_SCOPE_GROUP) deps.bumpStat('groupChatRowsReceived');
      },
    });

    wireReactions(c, rows, {
      showLocalReaction: (emoji) => gameApp.showLocalReaction(emoji),
      showRemoteReaction: (idHex, emoji) => gameApp.showRemoteReaction(idHex, emoji),
    });

    players.wireRowEvents(admission);

    // The first decision: enter (the pre-admission behavior), or hold and
    // show why. The subscription was applied before wireSession, so this
    // rules on real rows.
    admission.reevaluate();
  }

  return { wireSession, dropSession };
}
