// fallow-ignore-file coverage-gaps -- wires a live SpacetimeDB connection to the game loop; needs a running host. The admission rules it acts on are pure and unit-tested in @maple/shared (see admission.ts)
import {
  type Availability,
  type ChatDraftPlan,
  type E2ENetStats,
  HEARTBEAT_INTERVAL_MS,
  type MemberAction,
  planChatDraft,
  type ReactionEmoji,
  type StatusView,
  stateFromRow,
  statusLabel,
} from '@maple/shared';
import { Identity } from 'spacetimedb';
import type { GameApp } from '../game.package';
import type { DbConnection } from '../module_bindings';
import { type SpaceView, wireAdmission } from './admission';
import { createChatFeed, dmCandidatesOf } from './chatFeed';
import type { ChatLog } from './chatLog';
import { type AuthTokenGetter, type Connected, connect, target } from './connection';
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
import { createPrediction } from './prediction';
import { wireReactions } from './reactionFeed';
import { createRemoteViews } from './remoteView';
import type { RowOf } from './rows';
import { cachedStatusView, wireStatuses } from './statusFeed';

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
 * effect kind a compile error (a missing key). The lifecycle's own event
 * switch stays the idiomatic form because its transition is unit-tested.
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
 * だけ窓に晒す(GameApp の __mapleE2E と同じ流儀)。本番ビルドはビルド時
 * 定数でコードごと消える。
 */
function installNetStats(): E2ENetStats | undefined {
  if (!import.meta.env.DEV) return undefined;
  const stats: E2ENetStats = { inputBatchesSent: 0, heartbeatsSent: 0, dmRowsReceived: 0 };
  window.__mapleE2ENet = stats;
  return stats;
}

export interface Net {
  dispose(): void;
  /**
   * Asks the server to rename this player (set_display_name). The result
   * arrives as an own player_name row event, which is also the caller's
   * success signal. Failures (a disconnect racing the submit, a server
   * rejection) only log: the form keeps its draft, so the user can see the
   * label didn't change and resubmit.
   */
  setDisplayName(name: string): void;
  /**
   * Files (or re-files, after a rejection) this client's membership
   * application. Success arrives as the own space_member row appearing in
   * the subscription; the server refuses guests and duplicates.
   */
  applyForMembership(): void;
  /**
   * Admin actions: one member transition (MemberAction, on the identity a
   * SpaceMemberView carries) or the guest-admission setting. The server
   * re-checks that the sender is an acting admin; these methods exist for
   * the admin panel, whose gating is cosmetic. Success arrives as
   * space_member / space_setting row events (a fresh SpaceView); failures
   * only log, and the unchanged view is the visible outcome.
   */
  memberAction(action: MemberAction, member: Identity): void;
  setGuestsAllowed(allowed: boolean): void;
  /**
   * Posts one message to the global-scope chat (send_chat_message). Success
   * arrives as a chat_message row event — the log line and the speech
   * bubble both come from it, so the sender sees exactly what everyone
   * else received. Failures (a disconnect racing the submit, a server
   * refusal) log AND report through NetHooks.onChatRefused: the panel
   * clears the draft optimistically, so unlike the other reducers a
   * dropped call has no visible "nothing changed" signal to fall back on.
   */
  sendChatMessage(text: string): void;
  /**
   * Classifies one chat draft: public message, DM (with the mention
   * resolved against who is in the world and online RIGHT NOW, read from
   * the subscribed cache), or refused. The rules are the pure planChatDraft
   * in @maple/shared — this method only supplies the live candidate list
   * (empty while disconnected, so an @mention refuses rather than
   * resolving against stale rows). The caller sends the plan's text
   * through sendChatMessage or sendDm; splitting plan from send keeps the
   * panel's rate-limit mirror charging in between, exactly once per kind.
   */
  planChatSend(draft: string): ChatDraftPlan;
  /**
   * Sends one DM (send_dm) to the identity a plan resolved (its
   * recipientKey). Success arrives as a dm_message row event — the log
   * line comes from it, so the sender sees exactly what the recipient
   * received. Failures report through NetHooks.onChatRefused like a public
   * send: the panel cleared the draft optimistically either way.
   */
  sendDm(recipientKey: string, text: string): void;
  /**
   * Posts one palette-emoji reaction (send_reaction). Success arrives as a
   * reaction row event — the badge over the sender's avatar comes from it,
   * so the sender sees exactly what everyone else received. Failures only
   * log (no onChatRefused counterpart): a reaction is a transient gesture,
   * so a refused send simply not appearing is feedback enough.
   */
  sendReaction(emoji: ReactionEmoji): void;
  /**
   * Sets the sender's availability (set_availability) or free-text status
   * line (set_status_text; '' clears). Success arrives as a player_status
   * row event — the line under the avatar and the control's highlight both
   * come from it, so the sender sees exactly what everyone else received.
   * Failures only log: the authoritative view simply not changing is the
   * feedback (the setDisplayName rule), and the control keeps offering the
   * retry.
   */
  setAvailability(availability: Availability): void;
  setStatusText(text: string): void;
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
}

/** Each member transition's generated reducer call, keyed by the shared vocabulary. */
const MEMBER_ACTION_CALLS: Record<
  MemberAction,
  (c: DbConnection, identity: Identity) => Promise<unknown>
> = {
  approve: (c, identity) => c.reducers.approveMember({ identity }),
  reject: (c, identity) => c.reducers.rejectMember({ identity }),
  ban: (c, identity) => c.reducers.banMember({ identity }),
  unban: (c, identity) => c.reducers.unbanMember({ identity }),
};

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

  gameApp.onLocalTick((state, tick, packedInput) => {
    if (!prediction) return;
    prediction.onTick(state, tick, packedInput, performance.now());
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

  function wireSession(
    c: DbConnection,
    myIdentity: Identity,
    myIdHex: string,
    generation: number,
  ): void {
    // True once this session's events must be ignored: the stack is torn
    // down, or a newer connect has taken over (an idle resume can start one
    // while this session's socket is still closing).
    const stale = () => life.disposed || generation !== life.generation;

    // Names live on player_name, split off the hot row so movement updates
    // do not re-broadcast them (ROADMAP Phase 2 の player 行ダイエット). The
    // SDK applies a whole transaction to the row cache before firing any
    // callback, and the server writes the two rows in the same transaction,
    // so a player row's name is always in the cache by the time its row
    // event runs; '' can only be read mid-teardown, when nothing renders.
    const nameOf = (identity: Identity): string =>
      c.db.playerName.identity.find(identity)?.name ?? '';

    // The display attributes record() carries per row change, read from the
    // cache like nameOf. The status seed rides here: a freshly (re)created
    // view — session seed, or a player coming back from the offline-hidden
    // state — starts with the cached status (see cachedStatusView).
    const labelOf = (identity: Identity) => ({
      name: nameOf(identity),
      status: statusLabel(cachedStatusView(c, identity)),
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
      );
      gameApp.start(stateFromRow(row), row.tick);
    };

    // Offline rows linger server-side for the retention window (so their owner
    // can resume) but should not be visible in the world.
    const recordRemote = (idHex: string, row: PlayerRow) => {
      if (!row.online) {
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
        handleOwnRow(own);
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
      countDmRow: () => bumpStat('dmRowsReceived'),
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
        handleOwnRow(row);
        return;
      }
      recordRemote(idHex, row);
    });
    c.db.player.onUpdate((_ctx, _old, row) => {
      if (stale()) return;
      const idHex = row.identity.toHexString();
      if (idHex === myIdHex) {
        // A live own row flipped to offline: a half-open TCP session's
        // client_disconnected landing AFTER this connection took over (the
        // race the reducer comment on `online: true` describes). Other
        // clients hide offline rows immediately, and while the send gate is
        // closed nothing else would correct the flag until the next input
        // or scheduled heartbeat (minutes) — so re-announce liveness now.
        // Pre-suppression, the 100ms input stream fixed this incidentally.
        if (!row.online) sendHeartbeat(c);
        // An own-row update IS the acknowledgement (row.tick = applied count).
        prediction?.onAck(stateFromRow(row), row.tick, performance.now());
        return;
      }
      recordRemote(idHex, row);
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
        wireSession(settled.conn, settled.myIdentity, settled.myIdHex, e.generation);
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
          const effects = dispatch({ kind: 'socket-closed', generation });
          // Only an unexpected drop of the live session is worth a log: a
          // stale close produces no effects, and a close the idle guard
          // asked for leaves the state suspended.
          if (effects.some((e) => e.kind === 'drop-session') && !life.suspended) {
            console.warn('SpacetimeDB: connection dropped, reconnecting');
          }
        },
      },
      consecutiveFailures,
      getAuthToken,
    )
      .then((settled) => {
        dispatch({ kind: 'connect-ok' }, settled);
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

  /**
   * The shared shell of every user-triggered reducer call: drop with a
   * warning while disconnected, log a server refusal. Success never needs
   * handling here — it arrives as row events (see the Net method docs).
   * `onRefused` is for the one caller (chat) whose UI otherwise has no
   * "nothing changed" signal to fall back on; it runs on both the
   * disconnected drop and a server rejection.
   */
  function callReducer(
    name: string,
    call: (c: DbConnection) => Promise<unknown>,
    onRefused?: () => void,
  ): void {
    if (!conn) {
      console.warn(`SpacetimeDB: not connected, ${name} dropped`);
      onRefused?.();
      return;
    }
    call(conn).catch((err: unknown) => {
      console.error(`SpacetimeDB: ${name} rejected`, err);
      onRefused?.();
    });
  }

  /**
   * Builds the common Net method shape: one argument forwarded to one
   * reducer through callReducer. A factory rather than five hand-written
   * one-line wrappers because those wrappers are token-identical and only
   * grow with every posting feature (chat, reaction, status…) — the exact
   * repetition the semantic clone gate exists to stop. Methods that differ
   * (no argument, two arguments, a refusal hook) stay written out.
   */
  function forward<A>(
    name: string,
    call: (c: DbConnection, arg: A) => Promise<unknown>,
  ): (arg: A) => void {
    return (arg) => callReducer(name, (c) => call(c, arg));
  }

  return {
    dispose() {
      dispatch({ kind: 'dispose' });
      clearInterval(idleTimer);
      heartbeat.dispose();
      // Guarded so a torn-down instance cannot erase the counters installed
      // by the instance that outlives it (StrictMode mounts two in parallel).
      if (netStats && window.__mapleE2ENet === netStats) window.__mapleE2ENet = undefined;
      for (const type of ACTIVITY_EVENTS) {
        window.removeEventListener(type, onActivity, { capture: true });
      }
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
    setDisplayName: forward('set_display_name', (c, name: string) =>
      c.reducers.setDisplayName({ name }),
    ),
    applyForMembership() {
      callReducer('apply_for_membership', (c) => c.reducers.applyForMembership({}));
    },
    memberAction(action, member) {
      callReducer(`${action}_member`, (c) => MEMBER_ACTION_CALLS[action](c, member));
    },
    setGuestsAllowed: forward('set_guests_allowed', (c, allowed: boolean) =>
      c.reducers.setGuestsAllowed({ allowed }),
    ),
    sendChatMessage(text) {
      callReducer(
        'send_chat_message',
        (c) => c.reducers.sendChatMessage({ text }),
        hooks.onChatRefused,
      );
    },
    planChatSend(draft) {
      return planChatDraft(draft, conn ? dmCandidatesOf(conn) : []);
    },
    sendDm(recipientKey, text) {
      callReducer(
        'send_dm',
        (c) => c.reducers.sendDm({ recipient: Identity.fromString(recipientKey), text }),
        hooks.onChatRefused,
      );
    },
    sendReaction: forward('send_reaction', (c, emoji: ReactionEmoji) =>
      c.reducers.sendReaction({ emoji }),
    ),
    setAvailability: forward('set_availability', (c, availability: Availability) =>
      c.reducers.setAvailability({ availability }),
    ),
    setStatusText: forward('set_status_text', (c, text: string) =>
      c.reducers.setStatusText({ text }),
    ),
  };
}
