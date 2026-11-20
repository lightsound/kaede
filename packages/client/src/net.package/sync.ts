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
  onOwnName(name: string | undefined): void;
  onSpace(view: SpaceView): void;
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
  onZones(zones: ZoneAdminView[]): void;
  onHuddle(view: HuddleView): void;
  onChatScopes(view: ChatScopeView): void;
  onOwnGroup(groupId: bigint | undefined): void;
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
  const chatFeed = createChatFeed(hooks.onChat);
  let conn: DbConnection | undefined;
  let life = initialLifecycle();

  const netStats = installNetStats();
  const bumpStat = (key: keyof E2ENetStats): void => {
    if (netStats) netStats[key] += 1;
  };

  const sim: OwnSim = {
    prediction: undefined,
    currentMapId: DEFAULT_MAP_ID,
    portalPendingAtMs: undefined,
  };

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

  gameApp.onFrame((now) => {
    remoteViews.renderFrame(now, gameApp.upsertRemotePlayer);
  });

  dispatch({ kind: 'start' });

  const stopActivity = watchActivity({ isDisposed: () => life.disposed, dispatch });

  const heartbeat = createHeartbeat(inputSender.heartbeatTick);

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
