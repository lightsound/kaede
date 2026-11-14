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

/** What session wiring needs from the net stack that owns it (startNet). */
export interface SessionWiringDeps {
  gameApp: GameApp;
  /** The remote players' interpolated views, kept across sessions (remoteView.ts). */
  remoteViews: ReturnType<typeof createRemoteViews>;
  /** The chat feed, which owns its log across sessions (chatFeed.ts). */
  chatFeed: ReturnType<typeof createChatFeed>;
  /** The own simulation's state, held across sessions (see OwnSim in playerFeed.ts). */
  sim: OwnSim;
  /** The single paths for own-name / own-status changes (ownPublishers.ts). */
  publishers: OwnPublishers;
  /** The own simulation's send paths (inputSender.ts). */
  inputSender: InputSender;
  /** Counts one row event on the dev-only E2E counters (see installNetStats in sync.ts). */
  bumpStat(key: keyof E2ENetStats): void;
  /** Every space_member / space_setting change (NetHooks.onSpace). */
  onSpace(view: SpaceView): void;
  /** Every conversation_group change, as the whole zone list (NetHooks.onZones). */
  onZones(zones: ZoneAdminView[]): void;
  /** Every change of the huddle control's answer (NetHooks.onHuddle). */
  onHuddle(view: HuddleView): void;
  /** Every change of the sendable chat scopes (NetHooks.onChatScopes). */
  onChatScopes(view: ChatScopeView): void;
  /** Every change of the conversation group this client is in (NetHooks.onOwnGroup). */
  onOwnGroup(groupId: bigint | undefined): void;
  /** Every call_recording change, as the whole label list (NetHooks.onRecordings). */
  onRecordings(labels: RecordingLabelView[]): void;
  /** Every dm_message row handed to this client (NetHooks.onDmRow). */
  onDmRow(event: DmRowEvent): void;
  /**
   * Whether the session of `generation` must already be ignored: the
   * stack is torn down, or a newer connect has taken over.
   */
  isStale(generation: number): boolean;
  /** Drops the stack's live-connection ref (the session half of teardown). */
  clearConnection(): void;
}

/** One stack's session entry and exit, driven by the lifecycle driver. */
export interface SessionWiring {
  /** Wires every feed to a freshly settled connection's rows. */
  wireSession(settled: Connected, generation: number): void;
  /** Tears the live session's state down (prediction, remote views, own name). */
  dropSession(): void;
}

/**
 * Builds the session wiring. Building it has no side effects; the
 * lifecycle driver runs wireSession per adopted connection and
 * dropSession whenever the machine cuts one.
 */
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
    // True once this session's events must be ignored: the stack is torn
    // down, or a newer connect has taken over (an idle resume can start one
    // while this session's socket is still closing).
    const stale = () => deps.isStale(generation);
    // This session's row events: every feed registers its handlers through
    // them, so none acts once stale (see rowEvents.ts).
    const rows = sessionRows(myIdHex, stale);

    // The whole-session map state: the shared currentMapId (the tick
    // callback reads it, and so does the zone feed's seed refresh below,
    // which is why this comes first), and the rendered map — set here
    // because a session may resume an identity that left off on another
    // map, or replace a session that did.
    sim.currentMapId = settled.mapId;
    sim.portalPendingAtMs = undefined;
    gameApp.setMap(mapFor(sim.currentMapId));

    // Statuses: state wiring, seed + row events (the opposite of the
    // reaction seed rule) — see statusFeed.ts. The seed half rides labelOf
    // and handleOwnRow (playerFeed.ts); the events land here.
    wireStatuses(c, rows, {
      applyOwn: publishers.publishOwnStatus,
      applyRemote: (idHex, view) =>
        remoteViews.patchLabel(idHex, {
          status: statusLabel(view),
          availability: view.availability,
        }),
    });

    // Gestures (Phase 5 ①c): the third display convention — state poses
    // (sit / sleep / dance) seed + events like statuses, the transient
    // wave events-only like reactions; the split lives in gestureFeed.ts.
    // The seed half rides labelOf and handleOwnRow (playerFeed.ts).
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

    // The own-group signal for the call dock (ROADMAP Phase 4 増分①): the
    // same own group_member row the scope feed reads, but as the raw
    // groupId — the call's identity, not a chat affordance (see callFeed.ts).
    wireOwnGroup(c, rows, myIdentity, { onOwnGroup: deps.onOwnGroup });

    // The recording labels for the 録画一覧 (ROADMAP Phase 4 増分④).
    wireRecordings(c, rows, { onRecordings: deps.onRecordings });

    // The RLS privacy probe for the call registry (the groupChatRowsReceived
    // idea): how many group_call rows — join capabilities — this connection
    // was actually handed. Insert events only; the seed is counted by the
    // cache enumeration below, so a reloaded client still reports what the
    // seed delivered.
    for (const _row of c.db.groupCall.iter()) deps.bumpStat('groupCallRowsReceived');
    rows.on(c.db.groupCall, { insert: () => deps.bumpStat('groupCallRowsReceived') });

    // The player rows (playerFeed.ts): the own row drives the simulation,
    // remote rows the interpolated views, player_name rows the labels.
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

    // Admission (承認制 / ゲスト入場設定): the rules live in admission.ts;
    // this session supplies what acting on them needs.
    const admission = wireAdmission(c, rows, myIdentity, {
      onSpace: deps.onSpace,
      enterWorld: players.enterWorld,
    });

    // Seed the remote players already in the world (our own surviving row
    // waits for the admission re-evaluation below — see seedRemotes).
    players.seedRemotes();

    // Chat: the feed seeds its log from the cache and keeps it (and the
    // speech bubbles) fed by row events — see chatFeed.ts.
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

    // Reactions: display-only wiring, row events only (no seed) — see
    // reactionFeed.ts, which also owns the palette narrowing of the raw
    // row string.
    wireReactions(c, rows, {
      showLocalReaction: (emoji) => gameApp.showLocalReaction(emoji),
      showRemoteReaction: (idHex, emoji) => gameApp.showRemoteReaction(idHex, emoji),
    });

    // The player / player_name row events (see wireRowEvents); a deleted
    // own row re-runs admission.
    players.wireRowEvents(admission);

    // The first decision: enter (the pre-admission behavior), or hold and
    // show why. The subscription was applied before wireSession, so this
    // rules on real rows.
    admission.reevaluate();
  }

  return { wireSession, dropSession };
}
