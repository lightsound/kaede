// fallow-ignore-file coverage-gaps -- wires a live SpacetimeDB connection to the game loop; needs a running host. The admission rules it acts on are pure and unit-tested in @kaede/shared (see admission.ts)
import {
  CHAT_SCOPE_GROUP,
  DEFAULT_MAP_ID,
  type DmRowEvent,
  decidePortalCall,
  type E2ENetStats,
  HEARTBEAT_INTERVAL_MS,
  isGroundContactEdge,
  mapFor,
  type PlayerState,
  type StatusView,
  statusLabel,
  unpackInput,
} from '@kaede/shared';
import type { GameApp } from '../game.package';
import type { DbConnection } from '../module_bindings';
import { captureEvent } from '../telemetry.package';
import { watchActivity } from './activity';
import { type SpaceView, wireAdmission } from './admission';
import { wireOwnGroup } from './callFeed';
import { createChatFeed } from './chatFeed';
import type { ChatLog } from './chatLog';
import { type ChatScopeView, wireChatScopes } from './chatScopeFeed';
import { type AuthTokenGetter, type Connected, connect, target } from './connection';
import { wireGestures } from './gestureFeed';
import { createHeartbeat } from './heartbeat';
import {
  type ConnectionStatus,
  initialLifecycle,
  type LifecycleEffect,
  type LifecycleEvent,
  transition,
} from './lifecycle';
import { createNetApi, type NetApi } from './netApi';
import { createPlayerFeed, type OwnSim } from './playerFeed';
import { wireReactions } from './reactionFeed';
import { type RecordingLabelView, wireRecordings } from './recordingFeed';
import { createRemoteViews } from './remoteView';
import { sessionRows } from './rowEvents';
import { wireStatuses } from './statusFeed';
import { type HuddleView, wireZones, type ZoneAdminView } from './zoneFeed';

export type { ConnectionStatus } from './lifecycle';

/**
 * One runner per lifecycle effect kind, each receiving its narrowed payload.
 * A handler MAP rather than the codebase's usual `switch` + `satisfies never`
 * deliberately: this shell is uncovered (it needs a live host — see the
 * fallow-ignore header), and a 9-branch uncovered switch busts the CRAP
 * budget fallow enforces, while a map is branch-free and still makes a new
 * effect kind a compile error (a missing key). The lifecycle's event
 * dispatch adopted the same shape once its switch grew big enough to trip
 * the clone detector (see eventHandlers in lifecycle.ts).
 */
type EffectRunners = {
  [K in LifecycleEffect['kind']]: (effect: Extract<LifecycleEffect, { kind: K }>) => void;
};

/**
 * Calls the runner matching the effect's kind. Generic over the kind so the
 * indexed access stays correlated — the runner receives exactly its own
 * payload type, with no cast and no narrowing switch.
 */
function runEffect<K extends LifecycleEffect['kind']>(
  runners: EffectRunners,
  effect: Extract<LifecycleEffect, { kind: K }>,
): void {
  const runner: (e: typeof effect) => void = runners[effect.kind];
  runner(effect);
}

/**
 * 送信カウンタ(Playwright 用の読み取り専用フック)。「静止中は送信が止まる」
 * はレンダリングからは観測できないので、送った回数そのものを dev ビルド
 * だけ窓に晒す(GameApp の __kaedeE2E と同じ流儀)。本番ビルドはビルド時
 * 定数でコードごと消える。
 */
function installNetStats(): E2ENetStats | undefined {
  if (!import.meta.env.DEV) return undefined;
  const stats: E2ENetStats = {
    inputBatchesSent: 0,
    heartbeatsSent: 0,
    dmRowsReceived: 0,
    dmNotifyDecisions: 0,
    groupChatRowsReceived: 0,
    groupCallRowsReceived: 0,
    playerRowUpdates: 0,
  };
  window.__kaedeE2ENet = stats;
  return stats;
}

/**
 * The whole net facade: the user-action surface (NetApi — the methods every
 * UI control calls, built in netApi.ts) plus the one lifecycle-owning
 * method that must live with the connection state machine here.
 */
export interface Net extends NetApi {
  dispose(): void;
}

/**
 * Everything the net stack reports back to the UI. One object rather than
 * a parameter per callback: the four `(x) => void` consumers had grown
 * positional (swapping onOwnName/onSpace would have compiled), and the
 * admission package already set the object-of-hooks precedent.
 */
export interface NetHooks {
  onStatus(status: ConnectionStatus): void;
  /** See startNet's own-name contract in the doc comment below. */
  onOwnName(name: string | undefined): void;
  /** Every space_member / space_setting change, as one SpaceView. */
  onSpace(view: SpaceView): void;
  /** Every chat_message change (seed and row events), as one whole log. */
  onChat(log: ChatLog): void;
  /**
   * The own manual status whenever the authority's view of it changes —
   * session entry (seeded from the cache), every own player_status row
   * event, and the row's deletion (back to DEFAULT_STATUS). What keeps the
   * status control's highlight honest: it renders this, never what was
   * clicked.
   */
  onOwnStatus(view: StatusView): void;
  /**
   * A chat or DM send that will never land: dropped while disconnected, or
   * refused by the server after the client-side checks let it through
   * (the per-identity rate bucket shared by a member's other tab — the
   * mirror is per-tab — or a DM recipient who left between the mention
   * resolving and the call landing). The panel surfaces it; without this
   * the cleared draft would just silently vanish.
   */
  onChatRefused(): void;
  /**
   * Every dm_message row handed to this client (subscription seed and
   * insert events alike, source-tagged) — the browser-notification feed.
   * Whether a row becomes a notification, and every environment read that
   * takes (visibility, permission, the mute), lives behind this hook
   * (notify.package), so the net stack stays notification-agnostic.
   * Never fires for a torn-down or superseded session: the chat feed calls
   * it from its seed and from row events registered through SessionRows.
   */
  onDmRow(event: DmRowEvent): void;
  /**
   * Every conversation_group change, as the whole zone list (all maps) —
   * what the admin panel's zone section renders (ROADMAP Phase 3 増分②).
   */
  onZones(zones: ZoneAdminView[]): void;
  /**
   * Every change of the huddle control's answer (own huddle / joinable
   * huddle / neither — ROADMAP Phase 3 増分③), deduplicated by value in
   * the feed so the row-event cadence stays out of React.
   */
  onHuddle(view: HuddleView): void;
  /**
   * Every change of the chat scopes this client may send under (全体 /
   * このマップ / いまの会話グループ — ROADMAP Phase 3 増分④), deduplicated
   * by value in the feed. The selector renders exactly this list, so a
   * scope the server would refuse is never offered.
   */
  onChatScopes(view: ChatScopeView): void;
  /**
   * Every change of which conversation group this client is in (seeded on
   * session entry, deduplicated by value — ROADMAP Phase 4 増分①). The
   * call dock offers 通話 from it and auto-leaves the call when it stops
   * naming the call's group.
   */
  onOwnGroup(groupId: bigint | undefined): void;
  /**
   * Every call_recording change, as the whole label list (newest first —
   * ROADMAP Phase 4 増分④). The 録画一覧 decorates the module's R2
   * listing (list_recordings) with these; the rows themselves carry no
   * download capability.
   */
  onRecordings(labels: RecordingLabelView[]): void;
}

/**
 * Wires the game to SpacetimeDB. The server is authoritative: the client sends
 * only inputs (batched through submit_inputs) and predicts locally, replaying
 * un-acked inputs whenever the authoritative row disagrees with our prediction.
 * Remote players are rendered interpolated INTERP_DELAY_MS in the past.
 *
 * Connection failures and drops are retried forever with exponential backoff;
 * `onStatus` keeps the UI informed. When a connect may start, when a retry
 * arms, and which socket events are stale is decided by the pure lifecycle
 * state machine (lifecycle.ts); this file only performs the effects it
 * returns (timers, sockets, status callbacks). The one exception to forever
 * retrying is idle suspension: after IDLE_DISCONNECT_MS without user input
 * this client closes the connection itself (status 'idle') and reconnects on
 * the next input — an unattended tab must not stream traffic (= Maincloud
 * energy) forever (see idle.ts). On reconnect the identity is resumed —
 * via a fresh OIDC token from `getAuthToken` when signed in, or this tab's
 * stored anonymous token otherwise (see connection.ts) — so the server hands
 * back the same player row and the local sim snaps to that authoritative state.
 *
 * Entering the world is gated by admission (承認制 / ゲスト入場設定): the
 * client rules on the same subscribed rows the server's join checks
 * (decideAdmission), sends join only when it would be admitted, and reacts
 * to approvals and setting flips the moment the rows change. `onSpace`
 * reports every such change; see SpaceView.
 *
 * `onOwnName` reports the authoritative display name whenever it changes,
 * and `undefined` whenever the own row stops being known to exist (before
 * the first spawn, after a disconnect, after the row is deleted by the
 * retention sweep). "Defined" therefore means "a row exists for
 * set_display_name to land on", which is what gates the name form.
 */
export function startNet(gameApp: GameApp, getAuthToken: AuthTokenGetter, hooks: NetHooks): Net {
  const remoteViews = createRemoteViews();
  // The chat log and bubbles, wired per session (wireSession); the feed
  // owns the log across sessions (see chatFeed.ts).
  const chatFeed = createChatFeed(hooks.onChat);
  let conn: DbConnection | undefined;
  // The whole retry/suspension/generation bookkeeping lives in this pure
  // state (see lifecycle.ts); everything below reads it through `life`.
  let life = initialLifecycle();
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  const netStats = installNetStats();
  const bumpStat = (key: keyof E2ENetStats): void => {
    if (netStats) netStats[key] += 1;
  };

  // The own simulation's state, held across sessions (see OwnSim in
  // playerFeed.ts): the tick callback and the heartbeat below read it,
  // wireSession and dropSession set and clear it, and each session's
  // player feed starts and re-maps the simulation.
  const sim: OwnSim = {
    prediction: undefined,
    currentMapId: DEFAULT_MAP_ID,
    portalPendingAtMs: undefined,
  };

  // いつ最後に submit_inputs を送ったか(バッチ・ハートビートとも)。
  // 送信ゲートが閉じている間はこれが HEARTBEAT_INTERVAL_MS だけ古くなり、
  // ハートビートの送りどきの判定材料になる。
  let lastSendMs = Date.now();

  /** 生存証明の空バッチを1本送る(定期便と再接続時の生存宣言の共通路)。 */
  function sendHeartbeat(c: DbConnection): void {
    lastSendMs = Date.now();
    bumpStat('heartbeatsSent');
    c.reducers.submitInputs({ startTick: 0, inputs: new Uint8Array(0) }).catch(() => {});
  }

  /** One input batch: the prediction's send path (see handleOwnRow in playerFeed.ts). */
  function sendBatch(startTick: number, packed: Uint8Array): void {
    // Batches lost to a dropping connection are expected and already
    // recovered by the resend watchdog, so a per-batch failure is not
    // worth reporting; logging one per flush would bury everything else.
    lastSendMs = Date.now();
    bumpStat('inputBatchesSent');
    conn?.reducers.submitInputs({ startTick, inputs: packed }).catch(() => {});
  }

  // The previous tick's packed input, for the portal intent's press edge.
  let prevPackedInput = 0;

  // 前 tick の接地状態(接地エッジ検出用)。undefined = まだ tick がない。
  // prediction の作り直し(再接続・マップ切替)を跨いでも高々1回の余分な
  // フラッシュにしかならないので、prevPackedInput と同じく張り替えない。
  let prevOnGround: boolean | undefined;

  /**
   * Fires enter_portal when this tick's input asks for it (standing in a
   * portal, up pressed this tick, no call already pending —
   * decidePortalCall in @kaede/shared, where the rule is unit-tested).
   * The pending window is flushed FIRST, off the cadence: the WebSocket is
   * ordered, so the server replays every tick the client has simulated
   * before the reducer runs, and its no-slack geometry re-check rules on
   * exactly the state this detection saw. The answer arrives as the own
   * row's mapId flipping (switchMap in playerFeed.ts); failures are silent
   * like submit_inputs — a refusal's only honest consequence is that the
   * map does not change.
   */
  function maybeEnterPortal(state: PlayerState, packedInput: number, prevPacked: number): void {
    const c = conn;
    if (!c || !sim.prediction) return;
    const now = performance.now();
    const portalId = decidePortalCall({
      nowMs: now,
      pendingSinceMs: sim.portalPendingAtMs,
      input: unpackInput(packedInput),
      prevInput: unpackInput(prevPacked),
      state,
      map: mapFor(sim.currentMapId),
    });
    if (portalId === undefined) return;
    sim.prediction.flushNow(now);
    sim.portalPendingAtMs = now;
    c.reducers.enterPortal({ portalId }).catch(() => {});
  }

  gameApp.onLocalTick((state, tick, packedInput) => {
    const prevPacked = prevPackedInput;
    prevPackedInput = packedInput;
    const wasOnGround = prevOnGround;
    prevOnGround = state.onGround;
    if (!sim.prediction) return;
    sim.prediction.onTick(state, tick, packedInput, performance.now());
    // 踏切・着地の tick は周期を待たず即フラッシュする(理由と費用は
    // isGroundContactEdge のコメントを参照)。ポータルと同じ flushNow なので
    // 周期時計もリセットされ、直後の定期便と二重にはならない。
    if (wasOnGround !== undefined && isGroundContactEdge(wasOnGround, state.onGround)) {
      sim.prediction.flushNow(performance.now());
    }
    maybeEnterPortal(state, packedInput, prevPacked);
  });

  // Render remote players interpolated INTERP_DELAY_MS in the past.
  gameApp.onFrame((now) => {
    remoteViews.renderFrame(now, gameApp.upsertRemotePlayer);
  });

  // The single path for own-name changes, so the label and the onOwnName
  // consumer cannot drift apart, and so the double report a join produces
  // (handleOwnRow and the player_name insert event both publish the same
  // name) is deduplicated here instead of leaning on React's same-value
  // bailout. `undefined` means "no own row is known".
  // Caller contract: any caller on an async event path must be
  // dispose-guarded at its entry point (see the row handlers in
  // playerFeed.ts, and admission.ts's rerun, which reaches it through
  // enterWorld) — dispose() itself is the only caller that may run after
  // the flip, and only with `undefined`.
  let lastOwnName: string | undefined;
  function publishOwnName(name: string | undefined): void {
    if (name === lastOwnName) return;
    lastOwnName = name;
    // The label keeps its last text while the row is gone: the local sprite
    // stays visible while offline (the sim keeps running), so blanking the
    // label would flash; the replacement row brings the authoritative name.
    if (name !== undefined) gameApp.patchLocalLabel({ name });
    hooks.onOwnName(name);
  }

  // The single path for own-status changes (the publishOwnName shape): the
  // canvas line and the onOwnStatus consumer cannot drift apart, and the
  // double report a session entry produces (handleOwnRow seeds from the
  // cache, then a row event may repeat the same value) is deduplicated by
  // value here. Unlike the name there is no "row unknown" state to report:
  // a missing row IS a status (the default), so the value never goes
  // undefined — the control disables through the onOwnName gate instead.
  // For the same reason dispose() has no reset counterpart to its
  // publishOwnName(undefined): a consumer surviving this stack holds a
  // stale-but-disabled value at worst, and the replacement stack's own
  // handleOwnRow seed (its dedupe starts empty) republishes the truth.
  let lastOwnStatus: StatusView | undefined;
  function publishOwnStatus(view: StatusView): void {
    if (
      lastOwnStatus !== undefined &&
      lastOwnStatus.availability === view.availability &&
      lastOwnStatus.text === view.text
    ) {
      return;
    }
    lastOwnStatus = view;
    // The composed line is the text display; the derived poses (away =
    // sleep, busy = headphones — ①c) read the raw availability.
    gameApp.patchLocalLabel({ status: statusLabel(view), availability: view.availability });
    hooks.onOwnStatus(view);
  }

  function dropSession(): void {
    sim.prediction = undefined;
    conn = undefined;
    sim.portalPendingAtMs = undefined;
    remoteViews.clear();
    gameApp.clearRemotePlayers();
    // Whether our row survives the retention window is unknowable while
    // offline; report it gone so the rename form disables until the row
    // (re)appears after the next join.
    publishOwnName(undefined);
  }

  function wireSession(settled: Connected, generation: number): void {
    const { conn: c, myIdentity, myIdHex } = settled;
    // True once this session's events must be ignored: the stack is torn
    // down, or a newer connect has taken over (an idle resume can start one
    // while this session's socket is still closing).
    const stale = () => life.disposed || generation !== life.generation;
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
      applyOwn: publishOwnStatus,
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
      onZones: hooks.onZones,
      onHuddle: hooks.onHuddle,
    });

    // The chat scope selector (ROADMAP Phase 3 増分④): which scopes this
    // client may address from where it stands — the zone feed's shape, over
    // the same rows (the own player row's map, the own membership) plus the
    // group rows' names. Its own feed rather than another branch of the
    // zone feed: the answer is about the chat panel, not about the zone
    // layer, and this file is long enough (see chatScopeFeed.ts).
    wireChatScopes(c, rows, myIdentity, { onChatScopes: hooks.onChatScopes });

    // The own-group signal for the call dock (ROADMAP Phase 4 増分①): the
    // same own group_member row the scope feed reads, but as the raw
    // groupId — the call's identity, not a chat affordance (see callFeed.ts).
    wireOwnGroup(c, rows, myIdentity, { onOwnGroup: hooks.onOwnGroup });

    // The recording labels for the 録画一覧 (ROADMAP Phase 4 増分④).
    wireRecordings(c, rows, { onRecordings: hooks.onRecordings });

    // The RLS privacy probe for the call registry (the groupChatRowsReceived
    // idea): how many group_call rows — join capabilities — this connection
    // was actually handed. Insert events only; the seed is counted by the
    // cache enumeration below, so a reloaded client still reports what the
    // seed delivered.
    for (const _row of c.db.groupCall.iter()) bumpStat('groupCallRowsReceived');
    rows.on(c.db.groupCall, { insert: () => bumpStat('groupCallRowsReceived') });

    // The player rows (playerFeed.ts): the own row drives the simulation,
    // remote rows the interpolated views, player_name rows the labels.
    const players = createPlayerFeed(settled, rows, {
      sim,
      gameApp,
      remoteViews,
      publishOwnName,
      publishOwnStatus,
      sendHeartbeat,
      sendBatch,
      countRowUpdate: () => bumpStat('playerRowUpdates'),
      refreshZones: zoneFeed.refresh,
    });

    // Admission (承認制 / ゲスト入場設定): the rules live in admission.ts;
    // this session supplies what acting on them needs.
    const admission = wireAdmission(c, rows, myIdentity, {
      onSpace: hooks.onSpace,
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
        bumpStat('dmRowsReceived');
        hooks.onDmRow(event);
      },
      onChatRow: (scope) => {
        if (scope === CHAT_SCOPE_GROUP) bumpStat('groupChatRowsReceived');
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

  /**
   * One runner per effect kind, built per dispatch so the runners close over
   * that dispatch's context: `closing` is the conn captured BEFORE the
   * effects run (so `disconnect` closes the connection the transition
   * decided to cut even after `drop-session` cleared the ref), and `settled`
   * is the connection a `connect-ok` event is about (not `conn` yet —
   * adopting it is itself an effect). A map instead of a switch so a new
   * effect kind is a compile error here, not a silently ignored case.
   */
  function effectRunners(
    closing: DbConnection | undefined,
    settled: Connected | undefined,
  ): EffectRunners {
    return {
      status: (e) => hooks.onStatus(e.status),
      connect: (e) => startConnect(e.generation, e.consecutiveFailures),
      'wire-session': (e) => {
        if (!settled) {
          // Unreachable — only a connect-ok dispatch carries a settled
          // connection — but narrowing must not read as a silent no-op
          // (the transitionMember precedent).
          console.error('SpacetimeDB: wire-session effect without a settled connection');
          return;
        }
        conn = settled.conn;
        wireSession(settled, e.generation);
      },
      'discard-attempt': () => settled?.conn.disconnect(),
      'arm-retry': (e) => {
        retryTimer = setTimeout(() => {
          retryTimer = undefined;
          dispatch({ kind: 'retry-due' });
        }, e.delayMs);
      },
      'cancel-retry': () => {
        clearTimeout(retryTimer);
        retryTimer = undefined;
      },
      'drop-session': () => dropSession(),
      disconnect: () => closing?.disconnect(),
      // Failure is fine: an announce that never lands just means the server
      // logs this cut as 'unannounced', which is the label it would have
      // gotten anyway without this effect.
      'announce-suspend': () => {
        closing?.reducers.announceIdleSuspend({}).catch(() => {});
      },
      'probe-session': (e) => {
        // Read the socket state the pure machine cannot: isSocketClosed
        // (SDK 2.7.1) is true even when the browser never delivered the
        // close event — the zombie a frozen tab leaves behind. Dispatching
        // from inside a runner is safe here because probe-session is always
        // its transition's only effect, so no sibling effect runs against
        // the superseded `life`.
        const c = conn;
        if (!c || c.isDisconnectRequested || !c.isSocketClosed) return;
        console.warn('SpacetimeDB: socket died while the page was hidden, reconnecting');
        captureEvent('spacetimedb_session_dead');
        dispatch({ kind: 'session-dead', generation: e.generation });
      },
    };
  }

  /** Runs one lifecycle step and performs its effects in order. */
  function dispatch(event: LifecycleEvent, settled?: Connected): LifecycleEffect[] {
    const step = transition(life, event);
    life = step.state;
    const runners = effectRunners(conn, settled);
    for (const effect of step.effects) runEffect(runners, effect);
    return step.effects;
  }

  /** One connect attempt; every outcome is reported back as a lifecycle event. */
  function startConnect(generation: number, consecutiveFailures: number): void {
    connect(
      {
        onDisconnect() {
          // Read BEFORE the dispatch: a failed handshake reports both a
          // rejection and this socket close, and the close's transition
          // still performs a (vacuous) drop-session — so the effect alone
          // cannot tell "an established session dropped" from "the connect
          // attempt never got one". Only the former is a disconnect; the
          // latter is already reported as spacetimedb_connect_failed.
          const wasLive = life.sessionLive;
          const effects = dispatch({ kind: 'socket-closed', generation });
          // Only an unexpected drop of the live session is worth a log: a
          // stale close produces no effects, and a close the idle guard
          // asked for leaves the state suspended. The same rule picks what
          // is worth a telemetry event (ADR §8.2-A: WebSocket は自動計装
          // されないため、送らなければ何も記録されない).
          if (wasLive && effects.some((e) => e.kind === 'drop-session') && !life.suspended) {
            console.warn('SpacetimeDB: connection dropped, reconnecting');
            captureEvent('spacetimedb_disconnected');
          }
        },
      },
      consecutiveFailures,
      getAuthToken,
    )
      .then((settled) => {
        // Recovery after a failure streak. The count is read before the
        // dispatch resets it, but the event is sent only if the success was
        // ADOPTED (wire-session): a connect settling into an idle-suspended
        // or disposed stack is discarded and leaves the user offline, which
        // must not read as a recovery. Successful first connects and clean
        // reconnects stay silent — the metric is "how long did retries fail".
        const failuresBeforeSuccess = life.consecutiveFailures;
        const effects = dispatch({ kind: 'connect-ok' }, settled);
        if (failuresBeforeSuccess > 0 && effects.some((e) => e.kind === 'wire-session')) {
          captureEvent('spacetimedb_reconnected', { failedAttempts: failuresBeforeSuccess });
        }
      })
      // The overlay can only ever say "connecting", so without this the actual
      // cause (host not running, unknown database name, stale schema) never
      // reaches anyone. Naming the target makes the common misconfigurations
      // self-evident from the first line of the log.
      .catch((err: unknown) => {
        const effects = dispatch({ kind: 'connect-failed' });
        const retry = effects.find(
          (e): e is Extract<LifecycleEffect, { kind: 'arm-retry' }> => e.kind === 'arm-retry',
        );
        // 再接続の連続失敗は例外として投げられない(ADR §8.2-A)ので、
        // 明示的に送る。失敗のたび1イベント(最短でも backoff 間隔)。
        captureEvent('spacetimedb_connect_failed', {
          consecutiveFailures: life.consecutiveFailures,
          everConnected: life.everConnected,
          willRetry: retry !== undefined,
        });
        console.error(
          `SpacetimeDB: connection to ${target} failed, ${
            retry ? `retrying in ${retry.delayMs}ms` : 'suspended for idle (input reconnects)'
          }`,
          err,
        );
      });
  }

  dispatch({ kind: 'start' });

  // What the user and the page do (activity.ts): input resumes an idle
  // suspension, the idle timeout suspends, and a page resume wakes stalled
  // retries and finds dead sockets.
  const stopActivity = watchActivity({ isDisposed: () => life.disposed, dispatch });

  // 静止中の生存証明: 送信ゲート(prediction.ts)が入力送信を止めている間、
  // サーバー行の updatedAt を進めるのはこの空バッチだけになる。これが絶えると
  // OFFLINE_RETENTION_MS 経過で行が掃除され、接続したまま静止している
  // プレイヤーが再join→スポーン地点テレポートしてしまう。Worker 駆動なのは
  // バックグラウンドタブのタイマー間引き対策(heartbeat.ts)。送りどきは
  // 「最後の送信から HEARTBEAT_INTERVAL_MS 以上」— 移動中は入力バッチが
  // lastSendMs を進めるので、ハートビートは自然に黙る。prediction がない間
  // (待合室・入場拒否・行の削除後)は行が無いので送らない。
  const heartbeat = createHeartbeat(() => {
    // dispose 後は heartbeat.dispose() 済みかつ conn も undefined。
    if (!conn || !sim.prediction) return;
    if (Date.now() - lastSendMs < HEARTBEAT_INTERVAL_MS) return;
    sendHeartbeat(conn);
  });

  // The user-action surface (netApi.ts), reading the live connection
  // through the closure so a reconnect swaps it under every method at once.
  const api = createNetApi({
    conn: () => conn,
    onChatRefused: () => hooks.onChatRefused(),
  });

  return {
    ...api,
    dispose() {
      dispatch({ kind: 'dispose' });
      stopActivity();
      heartbeat.dispose();
      // Guarded so a torn-down instance cannot erase the counters installed
      // by the instance that outlives it (StrictMode mounts two in parallel).
      if (netStats && window.__kaedeE2ENet === netStats) window.__kaedeE2ENet = undefined;
      conn = undefined;
      // The final "no row" signal. It cannot come from the disconnect
      // handler (which skips dropSession once disposed), and without it a
      // consumer surviving this stack (App remounting the net on an auth
      // change, StrictMode's probe mount) would carry a stale name into the
      // next session and enable the rename form before that session has a
      // row. Nothing can overwrite it: the row handlers refuse to run once
      // disposed.
      publishOwnName(undefined);
    },
  };
}
