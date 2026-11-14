// fallow-ignore-file coverage-gaps -- composes the net stack around a live SpacetimeDB connection; needs a running host. The pieces it composes are unit-tested where a seam exists (the feeds, the lifecycle machine, the own-view publishers, the input sender), and the admission rules it acts on are pure and unit-tested in @kaede/shared (see admission.ts)
import { DEFAULT_MAP_ID, type DmRowEvent, type E2ENetStats, type StatusView } from '@kaede/shared';
import type { GameApp } from '../game.package';
import type { DbConnection } from '../module_bindings';
import { watchActivity } from './activity';
import { type SpaceView } from './admission';
import { createChatFeed } from './chatFeed';
import type { ChatLog } from './chatLog';
import { type ChatScopeView } from './chatScopeFeed';
import { type AuthTokenGetter } from './connection';
import { createHeartbeat } from './heartbeat';
import { createInputSender } from './inputSender';
import { type ConnectionStatus, initialLifecycle, type LifecycleState } from './lifecycle';
import { createLifecycleDriver } from './lifecycleDriver';
import { createNetApi, type NetApi } from './netApi';
import { createOwnPublishers } from './ownPublishers';
import type { OwnSim } from './playerFeed';
import { type RecordingLabelView } from './recordingFeed';
import { createRemoteViews } from './remoteView';
import { createSessionWiring } from './sessionWiring';
import { type HuddleView, type ZoneAdminView } from './zoneFeed';

export type { ConnectionStatus } from './lifecycle';

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
 * state machine (lifecycle.ts); the driver this file builds
 * (lifecycleDriver.ts) only performs the effects it returns (timers,
 * sockets, status callbacks). The one exception to forever
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

  // The pieces this composition wires together: the own-view publishers
  // (ownPublishers.ts), the input sender (inputSender.ts), the session
  // wiring (sessionWiring.ts) and the lifecycle driver
  // (lifecycleDriver.ts) that runs the state machine's effects — the
  // wire-session and drop-session effects land on the session wiring, so
  // the driver is built last and handed both.
  const publishers = createOwnPublishers({
    patchLocalLabel: gameApp.patchLocalLabel,
    onOwnName: hooks.onOwnName,
    onOwnStatus: hooks.onOwnStatus,
  });
  const inputSender = createInputSender({ conn: () => conn, sim, bumpStat });
  const sessions = createSessionWiring({
    gameApp,
    remoteViews,
    chatFeed,
    sim,
    publishers,
    inputSender,
    bumpStat,
    onSpace: hooks.onSpace,
    onZones: hooks.onZones,
    onHuddle: hooks.onHuddle,
    onChatScopes: hooks.onChatScopes,
    onOwnGroup: hooks.onOwnGroup,
    onRecordings: hooks.onRecordings,
    onDmRow: hooks.onDmRow,
    isStale: (generation) => life.disposed || generation !== life.generation,
    clearConnection: () => {
      conn = undefined;
    },
  });
  const driver = createLifecycleDriver({
    getState: () => life,
    setState: (state: LifecycleState) => {
      life = state;
    },
    getConnection: () => conn,
    setConnection: (c: DbConnection | undefined) => {
      conn = c;
    },
    onStatus: hooks.onStatus,
    wireSession: sessions.wireSession,
    dropSession: sessions.dropSession,
    getAuthToken,
  });
  const dispatch = driver.dispatch;

  gameApp.onLocalTick(inputSender.handleLocalTick);

  // Render remote players interpolated INTERP_DELAY_MS in the past.
  gameApp.onFrame((now) => {
    remoteViews.renderFrame(now, gameApp.upsertRemotePlayer);
  });

  dispatch({ kind: 'start' });

  // What the user and the page do (activity.ts): input resumes an idle
  // suspension, the idle timeout suspends, and a page resume wakes stalled
  // retries and finds dead sockets.
  const stopActivity = watchActivity({ isDisposed: () => life.disposed, dispatch });

  // 静止中の生存証明(送りどきの規則は inputSender.ts の heartbeatTick)。
  const heartbeat = createHeartbeat(inputSender.heartbeatTick);

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
      publishers.publishOwnName(undefined);
    },
  };
}
