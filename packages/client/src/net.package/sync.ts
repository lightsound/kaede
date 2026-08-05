// fallow-ignore-file coverage-gaps -- wires a live SpacetimeDB connection to the game loop; needs a running host. The admission rules it acts on are pure and unit-tested in @kaede/shared (see admission.ts)
import {
  DEFAULT_MAP_ID,
  type DmRowEvent,
  decidePortalCall,
  type E2ENetStats,
  HEARTBEAT_INTERVAL_MS,
  mapFor,
  type PlayerState,
  type StatusView,
  stateFromRow,
  statusLabel,
  unpackInput,
} from '@kaede/shared';
import type { Identity } from 'spacetimedb';
import type { GameApp } from '../game.package';
import type { DbConnection } from '../module_bindings';
import { captureEvent } from '../telemetry.package';
import { type SpaceView, wireAdmission } from './admission';
import { createChatFeed } from './chatFeed';
import type { ChatLog } from './chatLog';
import {
  type AuthTokenGetter,
  type Connected,
  connect,
  subscribeMapPlayers,
  target,
} from './connection';
import { createHeartbeat } from './heartbeat';
import {
  createIdleMonitor,
  IDLE_CHECK_INTERVAL_MS,
  IDLE_DISCONNECT_MS,
  parseIdleTimeoutOverride,
} from './idle';
import {
  type ConnectionStatus,
  initialLifecycle,
  type LifecycleEffect,
  type LifecycleEvent,
  transition,
} from './lifecycle';
import { createNetApi, type NetApi } from './netApi';
import { createPrediction } from './prediction';
import { wireReactions } from './reactionFeed';
import { createRemoteViews } from './remoteView';
import type { RowOf } from './rows';
import { cachedStatusView, wireStatuses } from './statusFeed';
import { cachedZoneTag, type HuddleView, wireZones, type ZoneAdminView } from './zoneFeed';

export type { ConnectionStatus } from './lifecycle';

/** The generated own/remote player row type (all columns). */
type PlayerRow = RowOf<'player'>;

/** The generated player_name row type (the display name split off the hot row). */
type PlayerNameRow = RowOf<'playerName'>;

/** ユーザーの在席とみなす操作イベント。タイムスタンプを書くだけなので capture+passive で広く拾う。 */
const ACTIVITY_EVENTS = ['keydown', 'pointerdown', 'pointermove', 'wheel'] as const;

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
   * Already isStale-guarded: it fires inside the chat feed's session
   * handlers, never for a torn-down or superseded session.
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

  // The map the live session is scoped to: which player rows are subscribed
  // (subscribeMapPlayers), which geometry the prediction replays on, and
  // which map GameApp renders. Session state, but held here (like `conn`
  // and `prediction`) because the tick callback below — registered once,
  // outside any session — reads it for portal-intent detection. Updated by
  // wireSession on entry and by its switchMap on every teleport.
  let currentMapId = DEFAULT_MAP_ID;

  // Set while an enter_portal call is in flight; cleared when the own
  // row's map flips (switchMap) or PORTAL_PENDING_TIMEOUT_MS passes (the
  // rule and its rationale live in decidePortalCall, @kaede/shared).
  let portalPendingAtMs: number | undefined;

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

  // 無操作ガード: タイムアウトを超えたら接続(と再試行ループ)を休止し、次の
  // 操作で再開する。開発ビルドだけ ?idleMs= で短縮できる(E2E・手動確認用)。
  const idleTimeoutMs =
    (import.meta.env.DEV ? parseIdleTimeoutOverride(window.location.search) : undefined) ??
    IDLE_DISCONNECT_MS;
  const idle = createIdleMonitor(idleTimeoutMs, Date.now());

  // Prediction lives per connection: it is created once the authoritative own
  // row is known, and torn down (with the remote views) when the connection
  // drops. The local sim keeps running while offline; reconnecting snaps it
  // back to the authoritative row.
  let prediction: ReturnType<typeof createPrediction> | undefined;

  // The previous tick's packed input, for the portal intent's press edge.
  let prevPackedInput = 0;

  /**
   * Fires enter_portal when this tick's input asks for it (standing in a
   * portal, up pressed this tick, no call already pending —
   * decidePortalCall in @kaede/shared, where the rule is unit-tested).
   * The pending window is flushed FIRST, off the cadence: the WebSocket is
   * ordered, so the server replays every tick the client has simulated
   * before the reducer runs, and its no-slack geometry re-check rules on
   * exactly the state this detection saw. The answer arrives as the own
   * row's mapId flipping (switchMap in wireSession); failures are silent
   * like submit_inputs — a refusal's only honest consequence is that the
   * map does not change.
   */
  function maybeEnterPortal(state: PlayerState, packedInput: number, prevPacked: number): void {
    const c = conn;
    if (!c || !prediction) return;
    const now = performance.now();
    const portalId = decidePortalCall({
      nowMs: now,
      pendingSinceMs: portalPendingAtMs,
      input: unpackInput(packedInput),
      prevInput: unpackInput(prevPacked),
      state,
      map: mapFor(currentMapId),
    });
    if (portalId === undefined) return;
    prediction.flushNow(now);
    portalPendingAtMs = now;
    c.reducers.enterPortal({ portalId }).catch(() => {});
  }

  gameApp.onLocalTick((state, tick, packedInput) => {
    const prevPacked = prevPackedInput;
    prevPackedInput = packedInput;
    if (!prediction) return;
    prediction.onTick(state, tick, packedInput, performance.now());
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
  // dispose-guarded at its entry point (see wireSession's handlers) —
  // dispose() itself is the only caller that may run after the flip, and
  // only with `undefined`.
  let lastOwnName: string | undefined;
  function publishOwnName(name: string | undefined): void {
    if (name === lastOwnName) return;
    lastOwnName = name;
    // The label keeps its last text while the row is gone: the local sprite
    // stays visible while offline (the sim keeps running), so blanking the
    // label would flash; the replacement row brings the authoritative name.
    if (name !== undefined) gameApp.setLocalPlayerName(name);
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
    gameApp.setLocalStatus(statusLabel(view));
    hooks.onOwnStatus(view);
  }

  function dropSession(): void {
    prediction = undefined;
    conn = undefined;
    portalPendingAtMs = undefined;
    remoteViews.clear();
    gameApp.clearRemotePlayers();
    // Whether our row survives the retention window is unknowable while
    // offline; report it gone so the rename form disables until the row
    // (re)appears after the next join.
    publishOwnName(undefined);
  }

  /** Ask the server to spawn or resume our row; the answer arrives as a row event. */
  function joinWorld(c: DbConnection): void {
    // Admission is checked before calling this, so a refusal here means the
    // client's view of the rules drifted from the server's — worth a log.
    c.reducers.join({}).catch((err: unknown) => {
      console.error('SpacetimeDB: join failed, this client will not spawn', err);
    });
  }

  function wireSession(settled: Connected, generation: number): void {
    const { conn: c, myIdentity, myIdHex } = settled;
    // True once this session's events must be ignored: the stack is torn
    // down, or a newer connect has taken over (an idle resume can start one
    // while this session's socket is still closing).
    const stale = () => life.disposed || generation !== life.generation;

    // The map-scoped half of the player subscription (see connection.ts),
    // swapped by switchMap on every teleport. The whole-session state
    // follows: the shared currentMapId (the tick callback reads it), and
    // the rendered map — set here because a session may resume an identity
    // that left off on another map, or replace a session that did.
    let mapSub = settled.mapSub;
    currentMapId = settled.mapId;
    portalPendingAtMs = undefined;
    gameApp.setMap(mapFor(currentMapId));

    // Names live on player_name, split off the hot row so movement updates
    // do not re-broadcast them (ROADMAP Phase 2 の player 行ダイエット). The
    // SDK applies a whole transaction to the row cache before firing any
    // callback, and the server writes the two rows in the same transaction,
    // so a player row's name is always in the cache by the time its row
    // event runs; '' can only be read mid-teardown, when nothing renders.
    const nameOf = (identity: Identity): string =>
      c.db.playerName.identity.find(identity)?.name ?? '';

    // The display attributes record() carries per row change, read from the
    // cache like nameOf. The status and zone-tag seeds ride here: a freshly
    // (re)created view — session seed, or a player coming back from the
    // offline-hidden state — starts with the cached status and occupancy
    // (see cachedStatusView / cachedZoneTag).
    const labelOf = (identity: Identity) => ({
      name: nameOf(identity),
      status: statusLabel(cachedStatusView(c, identity)),
      zone: cachedZoneTag(c, identity),
    });

    // Our row appears (or already exists, when resuming an identity) via join
    // below. Start/refresh the simulation from that authoritative state.
    const handleOwnRow = (row: PlayerRow) => {
      if (prediction) return;
      publishOwnName(nameOf(row.identity));
      // The seed half of the status display (a status is state, so unlike
      // reactions the subscribed cache restores it on entry/reload); row
      // events keep it fresh from here (wireStatuses).
      publishOwnStatus(cachedStatusView(c, row.identity));
      // Announce liveness once per session start, unconditionally. Resuming
      // a surviving row skips join, so nothing server-side flips its offline
      // flag back or refreshes its updatedAt — and the send gate means no
      // input batch will arrive to do either while we stand still
      // (pre-suppression, the first 100ms flush did both incidentally).
      // Without this, a resumed player stays hidden from others until the
      // first input, and a row resumed near the end of its retention window
      // could be swept out from under a live client. For a fresh spawn the
      // server ignores the write (the row is younger than
      // HEARTBEAT_MIN_AGE_MS and online), so the cost is one reducer call
      // per entry. Sending also seeds lastSendMs = the heartbeat clock.
      sendHeartbeat(c);
      prediction = createPrediction(
        {
          sendBatch(startTick, packed) {
            // Batches lost to a dropping connection are expected and already
            // recovered by the resend watchdog, so a per-batch failure is not
            // worth reporting; logging one per flush would bury everything else.
            lastSendMs = Date.now();
            bumpStat('inputBatchesSent');
            conn?.reducers.submitInputs({ startTick, inputs: packed }).catch(() => {});
          },
          resetLocal(state, tick) {
            gameApp.resetLocal(state, tick);
          },
        },
        row.tick,
        stateFromRow(row),
        // The row's own map, not currentMapId: the two are equal on every
        // path into here (the map checks below route a mismatch through
        // switchMap first), but the row is the authority.
        mapFor(row.mapId).collision,
      );
      gameApp.start(stateFromRow(row), row.tick);
    };

    /**
     * Moves this client to the map its own row just landed on (the
     * enter_portal answer — or another device of the same identity
     * teleporting). Everything map-scoped restarts: the prediction (its
     * geometry is per-map), the rendered scene, the remote views (the
     * destination's population arrives with the swapped subscription), and
     * the player subscription itself — the destination map is subscribed
     * BEFORE the origin is dropped, so there is no window with neither
     * (the own row, covered by the identity query throughout, never
     * flickers either way — subscription overlap is refcounted).
     */
    const switchMap = (row: PlayerRow): void => {
      currentMapId = row.mapId;
      portalPendingAtMs = undefined;
      prediction = undefined;
      remoteViews.clear();
      gameApp.clearRemotePlayers();
      gameApp.setMap(mapFor(row.mapId));
      // The zone layer is a per-map projection like the map geometry; the
      // occupancy tags re-derive with it. Safe before zoneFeed's const
      // initializer only because nothing calls switchMap until the session
      // is fully wired (enterWorld and the row handlers all run later).
      zoneFeed.refresh();
      handleOwnRow(row);
      const outgoing = mapSub;
      mapSub = subscribeMapPlayers(c, row.mapId, () => {
        // The destination's rows just landed as insert events (recordRemote
        // picked them up). A stale session's socket is gone or superseded,
        // and its handles die with the connection — only a live session
        // needs to drop the origin's rows.
        if (!stale()) outgoing.unsubscribe();
      });
    };

    /**
     * One own-row update. The map flip (the enter_portal answer — or
     * another device of this identity teleporting) routes through
     * switchMap before anything acks. A live own row flipped to offline is
     * a half-open TCP session's client_disconnected landing AFTER this
     * connection took over (the race the reducer comment on `online: true`
     * describes): other clients hide offline rows immediately, and while
     * the send gate is closed nothing else would correct the flag until
     * the next input or scheduled heartbeat (minutes) — so liveness is
     * re-announced now (pre-suppression, the 100ms input stream fixed this
     * incidentally). Everything else IS the acknowledgement (row.tick =
     * applied count).
     */
    const applyOwnUpdate = (row: PlayerRow): void => {
      if (row.mapId !== currentMapId) {
        switchMap(row);
        return;
      }
      if (!row.online) sendHeartbeat(c);
      prediction?.onAck(stateFromRow(row), row.tick, performance.now());
    };

    // Offline rows linger server-side for the retention window (so their owner
    // can resume) but should not be visible in the world. Rows from another
    // map are dropped the same way: the subscription swap makes them rare
    // (the origin map's rows delete when its query unsubscribes), but during
    // the overlap window both maps' rows flow, and a remote player's own
    // teleport reaches us as an update whose mapId no longer matches.
    const recordRemote = (idHex: string, row: PlayerRow) => {
      if (!row.online || row.mapId !== currentMapId) {
        remoteViews.remove(idHex);
        gameApp.removeRemotePlayer(idHex);
        return;
      }
      remoteViews.record(
        idHex,
        labelOf(row.identity),
        { ...row, updatedAtMs: Number(row.updatedAt.toMillis()) },
        performance.now(),
      );
    };

    // A player_name change without the hot row moving: a rename round trip,
    // or a resumed row whose owner renamed on another device. Row events
    // carry it to whoever renders the label — the own-name consumers or the
    // remote view. No onDelete: names are deleted only alongside their
    // player row, whose own delete handling already tears the view down.
    const applyName = (row: PlayerNameRow): void => {
      const idHex = row.identity.toHexString();
      if (idHex === myIdHex) {
        publishOwnName(row.name);
        return;
      }
      remoteViews.setName(idHex, row.name);
    };

    // Statuses: state wiring, seed + row events (the opposite of the
    // reaction seed rule) — see statusFeed.ts. The seed half rides labelOf
    // and handleOwnRow; the events land here.
    wireStatuses(c, myIdHex, {
      isStale: stale,
      applyOwn: publishOwnStatus,
      applyRemote: (idHex, view) => remoteViews.setStatus(idHex, statusLabel(view)),
    });

    // Zones (ROADMAP Phase 3 増分②): the rendered zone layer, the occupancy
    // tags and the admin panel's zone list — statuses' wiring shape, plus a
    // per-map projection the map switch below re-pushes. Wired before the
    // admission block so its enterWorld (which may route through switchMap)
    // finds the feed ready.
    const zoneFeed = wireZones(c, myIdentity, {
      isStale: stale,
      currentMapId: () => currentMapId,
      setMapZones: (zones) => gameApp.setZones(zones),
      setMapHuddles: (huddles) => gameApp.setHuddles(huddles),
      applyOwnZone: (tag) => gameApp.setLocalZone(tag),
      applyRemoteZone: (idHex, tag) => remoteViews.setZone(idHex, tag),
      onZones: hooks.onZones,
      onHuddle: hooks.onHuddle,
    });

    /**
     * Enters the world once admission says so: resume the surviving own row
     * (a reload / blip within the retention window), or ask the server to
     * spawn one. Sitting behind the admission decision means a stale own
     * row can never start the simulation for a client that is not admitted.
     */
    const enterWorld = (): void => {
      if (prediction) return;
      const own = c.db.player.identity.find(myIdentity);
      if (own) {
        // A resumed row may sit on another map than the one this session
        // subscribed at connect time (another device of the same identity
        // teleporting in between): route through the map switch first.
        if (own.mapId !== currentMapId) switchMap(own);
        else handleOwnRow(own);
        return;
      }
      joinWorld(c);
    };

    // Admission (承認制 / ゲスト入場設定): the rules live in admission.ts;
    // this session supplies what acting on them needs.
    const admission = wireAdmission(c, myIdentity, {
      onSpace: hooks.onSpace,
      enterWorld,
      isStale: stale,
    });

    // Seed the remote players already in the world. Our own surviving row is
    // deliberately not resumed here: entering goes through the admission
    // re-evaluation below (its enterWorld picks the row up), so the
    // simulation can never start for a client the admission rules would
    // hold out.
    for (const row of c.db.player.iter()) {
      const idHex = row.identity.toHexString();
      if (idHex !== myIdHex) recordRemote(idHex, row);
    }

    // Chat: the feed seeds its log from the cache and keeps it (and the
    // speech bubbles) fed by row events — see chatFeed.ts.
    chatFeed.wire(c, myIdHex, {
      isStale: stale,
      showLocalBubble: (text) => gameApp.showLocalBubble(text),
      showRemoteBubble: (idHex, text) => gameApp.showRemoteBubble(idHex, text),
      onDmRow: (event) => {
        bumpStat('dmRowsReceived');
        hooks.onDmRow(event);
      },
    });

    // Reactions: display-only wiring, row events only (no seed) — see
    // reactionFeed.ts, which also owns the palette narrowing of the raw
    // row string.
    wireReactions(c, myIdHex, {
      isStale: stale,
      showLocalReaction: (emoji) => gameApp.showLocalReaction(emoji),
      showRemoteReaction: (idHex, emoji) => gameApp.showRemoteReaction(idHex, emoji),
    });

    // Every handler below refuses to run once stale: the socket closes
    // asynchronously, so this session's row events can still be delivered
    // after dispose() or after an idle resume replaced the session, and
    // acting on one would drive the destroyed Pixi app (gameApp.start,
    // prediction), re-install the e2e hook from the doomed instance, or
    // write to consumers shared with the replacement session (onOwnName
    // feeds the App's rename form). Guarding the event entry points covers
    // every side effect at once; the synchronous seeding above needs no
    // guard because neither dispose() nor a newer attempt can interleave
    // with it.
    c.db.player.onInsert((_ctx, row) => {
      if (stale()) return;
      const idHex = row.identity.toHexString();
      if (idHex === myIdHex) {
        // A fresh spawn lands on the session's map, but a re-join racing a
        // sweep (or another device) can insert the own row elsewhere.
        if (row.mapId !== currentMapId) switchMap(row);
        else handleOwnRow(row);
        return;
      }
      recordRemote(idHex, row);
    });
    c.db.player.onUpdate((_ctx, _old, row) => {
      if (stale()) return;
      const idHex = row.identity.toHexString();
      if (idHex === myIdHex) applyOwnUpdate(row);
      else recordRemote(idHex, row);
    });
    c.db.playerName.onInsert((_ctx, row) => {
      if (stale()) return;
      applyName(row);
    });
    c.db.playerName.onUpdate((_ctx, _old, row) => {
      if (stale()) return;
      applyName(row);
    });
    c.db.player.onDelete((_ctx, row) => {
      if (stale()) return;
      const idHex = row.identity.toHexString();
      if (idHex === myIdHex) {
        // Our row was reclaimed: by the retention sweep (a backgrounded tab
        // stops ticking and eventually looks abandoned), by the guest kick
        // that a guests-off flip performs, or by an admin expelling us. Stop
        // predicting against a row that no longer exists — and stop the
        // local simulation too, so a kicked player cannot keep walking a
        // ghost around under the admission overlay (the next start() snaps
        // to the authoritative replacement row). Then let the admission rule
        // decide whether to re-join — the sweep case — or to stay out and
        // say why.
        prediction = undefined;
        gameApp.stop();
        // No row again until a re-join lands; disable the rename form so a
        // submit cannot race into the server's no-target refusal.
        publishOwnName(undefined);
        admission.reevaluate();
        return;
      }
      remoteViews.remove(idHex);
      gameApp.removeRemotePlayer(idHex);
    });

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

  const onActivity = (): void => {
    if (life.disposed) return;
    if (idle.activity(Date.now()) !== 'resume') return;
    console.info('SpacetimeDB: user input detected, resuming the connection');
    dispatch({ kind: 'resume' });
  };
  for (const type of ACTIVITY_EVENTS) {
    window.addEventListener(type, onActivity, { capture: true, passive: true });
  }

  // ページ復帰の自動回復(lifecycle.ts の page-resume 節を参照): 背景タブで
  // 停滞した再試行の前倒しと、凍結中に onclose が届かないまま死んだソケット
  // (ゾンビ)の検出・再構築。SDK 2.7.1 の ConnectionManager と同じイベント
  // 群を購読する — visibilitychange は非表示→表示、focus は同一表示状態での
  // ウィンドウ切替、online はネットワーク復旧、pageshow は bfcache 復元
  // (visibilitychange が発火しないことがある)をそれぞれ拾う。
  const onPageResume = (): void => {
    if (life.disposed) return;
    dispatch({ kind: 'page-resume' });
  };
  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'visible') onPageResume();
  };
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('focus', onPageResume);
  window.addEventListener('online', onPageResume);
  window.addEventListener('pageshow', onPageResume);
  const idleTimer = setInterval(() => {
    if (life.disposed) return;
    if (idle.check(Date.now()) !== 'suspend') return;
    console.info(
      `SpacetimeDB: no user input for ${idleTimeoutMs}ms, suspending the connection (input resumes it)`,
    );
    dispatch({ kind: 'idle-timeout' });
  }, IDLE_CHECK_INTERVAL_MS);

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
    if (!conn || !prediction) return;
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
      clearInterval(idleTimer);
      heartbeat.dispose();
      // Guarded so a torn-down instance cannot erase the counters installed
      // by the instance that outlives it (StrictMode mounts two in parallel).
      if (netStats && window.__kaedeE2ENet === netStats) window.__kaedeE2ENet = undefined;
      for (const type of ACTIVITY_EVENTS) {
        window.removeEventListener(type, onActivity, { capture: true });
      }
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('focus', onPageResume);
      window.removeEventListener('online', onPageResume);
      window.removeEventListener('pageshow', onPageResume);
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
