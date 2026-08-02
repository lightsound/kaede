// fallow-ignore-file coverage-gaps -- wires a live SpacetimeDB connection to the game loop; needs a running host. The admission rules it acts on are pure and unit-tested in @maple/shared (see admission.ts)
import { type MemberAction, stateFromRow } from '@maple/shared';
import type { Identity } from 'spacetimedb';
import type { GameApp } from '../game.package';
import type { DbConnection } from '../module_bindings';
import { type SpaceView, wireAdmission } from './admission';
import { type AuthTokenGetter, connect, target } from './connection';
import {
  createIdleMonitor,
  IDLE_CHECK_INTERVAL_MS,
  IDLE_DISCONNECT_MS,
  parseIdleTimeoutOverride,
} from './idle';
import { createPrediction } from './prediction';
import { createRemoteViews } from './remoteView';

/** The generated own/remote player row type (all columns). */
type PlayerRow =
  ReturnType<DbConnection['db']['player']['iter']> extends Iterator<infer R> ? R : never;

/**
 * What the user should be told about the connection right now. `idle` is the
 * deliberate offline state: this client cut the connection after
 * IDLE_DISCONNECT_MS without user input (see idle.ts) and will reconnect on
 * the next input.
 */
export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'idle';

/** ユーザーの在席とみなす操作イベント。タイムスタンプを書くだけなので capture+passive で広く拾う。 */
const ACTIVITY_EVENTS = ['keydown', 'pointerdown', 'pointermove', 'wheel'] as const;

/** First retry delay after a failure; doubles per attempt up to the max. */
const RETRY_INITIAL_MS = 1000;
const RETRY_MAX_MS = 30_000;

export interface Net {
  dispose(): void;
  /**
   * Asks the server to rename this player (set_display_name). The result
   * arrives as an own-row update, which is also the caller's success signal.
   * Failures (a disconnect racing the submit, a server rejection) only log:
   * the form keeps its draft, so the user can see the label didn't change
   * and resubmit.
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
 * `onStatus` keeps the UI informed. The one exception is idle suspension:
 * after IDLE_DISCONNECT_MS without user input this client closes the
 * connection itself (status 'idle') and reconnects on the next input — an
 * unattended tab must not stream traffic (= Maincloud energy) forever
 * (see idle.ts). On reconnect the identity is resumed —
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
export function startNet(
  gameApp: GameApp,
  onStatus: (status: ConnectionStatus) => void,
  getAuthToken: AuthTokenGetter,
  onOwnName: (name: string | undefined) => void,
  onSpace: (view: SpaceView) => void,
): Net {
  const remoteViews = createRemoteViews();
  let conn: DbConnection | undefined;
  let disposed = false;
  let everConnected = false;
  let retryDelayMs = RETRY_INITIAL_MS;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  // Connects that have failed in a row since the last success; connect() uses
  // it to decide when the stored identity token has become the likely culprit.
  let consecutiveFailures = 0;

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
  // consumer cannot drift apart, and so the ack firehose (every own-row
  // update, several per second) is deduplicated here instead of leaning on
  // React's same-value bailout. `undefined` means "no own row is known".
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
    onOwnName(name);
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

  /**
   * True while nothing may (re)arm the retry loop: the stack is torn down,
   * the idle guard suspended us on purpose (only a user input — the activity
   * listener — may end that state), or a timer is already armed. The armed
   * check matters because a failed connect both rejects and closes the
   * socket, so scheduleRetry is called twice for the same failure; without
   * it the backoff doubled twice per round (1s, 4s, 16s...) and each extra
   * timer was dropped from retryTimer unreferenced.
   */
  function retryBlocked(): boolean {
    return disposed || idle.suspended() || retryTimer !== undefined;
  }

  /** Arms the next attempt, at most once per failure (see retryBlocked). */
  function scheduleRetry(): void {
    if (retryBlocked()) return;
    onStatus(everConnected ? 'reconnecting' : 'connecting');
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      attempt();
    }, retryDelayMs);
    retryDelayMs = Math.min(retryDelayMs * 2, RETRY_MAX_MS);
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
    const stale = () => disposed || generation !== attemptGeneration;

    // Our row appears (or already exists, when resuming an identity) via join
    // below. Start/refresh the simulation from that authoritative state.
    const handleOwnRow = (row: PlayerRow) => {
      if (prediction) return;
      publishOwnName(row.name);
      prediction = createPrediction(
        {
          sendBatch(startTick, packed) {
            // Batches lost to a dropping connection are expected and already
            // recovered by the resend watchdog, so a per-batch failure is not
            // worth reporting; logging one per flush would bury everything else.
            conn?.reducers.submitInputs({ startTick, inputs: packed }).catch(() => {});
          },
          resetLocal(state, tick) {
            gameApp.resetLocal(state, tick);
          },
        },
        row.tick,
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
        row.name,
        { ...row, updatedAtMs: Number(row.updatedAt.toMillis()) },
        performance.now(),
      );
    };

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
      onSpace,
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
        // An own-row update IS the acknowledgement (row.tick = applied count).
        prediction?.onAck(stateFromRow(row), row.tick, performance.now());
        // The row also carries the display name, which a set_display_name
        // round trip may just have changed.
        publishOwnName(row.name);
        return;
      }
      recordRemote(idHex, row);
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

  // At most one connect may be in flight. Before idle suspension existed this
  // was structural (a new attempt only ever started after the previous one
  // failed); now a suspend can interleave with a pending connect and an input
  // can resume before that connect settles, so without the guard the resume
  // would race a second connect against the first and leave two live sessions.
  let attemptInFlight = false;
  // Which connect is current. A socket closes asynchronously, so the close of
  // a connection the idle guard cut can report after a resume already started
  // (or finished) a newer connect; callbacks stamped with an older generation
  // are stale and must not touch the newer session. An idle suspension bumps
  // the generation when it cuts a LIVE session, so that session turns stale
  // the moment we decide to cut it — not only once its socket finishes
  // closing. A merely pending connect keeps its generation (see
  // suspendForIdle).
  let attemptGeneration = 0;

  /**
   * True while a new connect may not start: the stack is torn down, one is
   * already in flight, or the idle guard holds the connection closed. The
   * idle.suspended() check is redundant today — scheduleRetry never arms a
   * timer while suspended, suspendForIdle clears any armed timer
   * (clearTimeout cancels a queued-but-not-started callback), and
   * onActivity lifts the suspension before calling attempt — but it makes
   * the invariant local: no future caller can start a connect nobody asked
   * for during a suspension.
   */
  function attemptBlocked(): boolean {
    return disposed || attemptInFlight || idle.suspended();
  }

  function attempt(): void {
    if (attemptBlocked()) return;
    attemptInFlight = true;
    attemptGeneration += 1;
    const generation = attemptGeneration;
    onStatus(everConnected ? 'reconnecting' : 'connecting');
    connect(
      {
        onDisconnect() {
          // Closes from a superseded session — an idle suspension bumped the
          // generation when cutting it, or a newer connect took over — are
          // stale and already torn down.
          if (disposed || generation !== attemptGeneration) return;
          dropSession();
          // A current-generation close while suspended is one we asked for:
          // the discard of a connect that settled after the idle guard cut
          // in mid-attempt (see the .then below). No warn, no retry — the
          // next user input reconnects (see the activity listener).
          if (idle.suspended()) return;
          console.warn('SpacetimeDB: connection dropped, reconnecting');
          scheduleRetry();
        },
      },
      consecutiveFailures,
      getAuthToken,
    )
      .then(({ conn: c, myIdentity, myIdHex }) => {
        attemptInFlight = false;
        // A connect that lands after dispose or while idle-suspended must
        // not open a session nobody asked for. A suspension leaves a pending
        // connect's generation current (see suspendForIdle), so when the
        // user has already resumed by now, this settle simply becomes the
        // live session — no generation check or replacement attempt needed.
        if (disposed || idle.suspended()) {
          c.disconnect();
          return;
        }
        conn = c;
        everConnected = true;
        consecutiveFailures = 0;
        retryDelayMs = RETRY_INITIAL_MS;
        onStatus('connected');
        wireSession(c, myIdentity, myIdHex, generation);
      })
      // The overlay can only ever say "connecting", so without this the actual
      // cause (host not running, unknown database name, stale schema) never
      // reaches anyone. Naming the target makes the common misconfigurations
      // self-evident from the first line of the log.
      .catch((err: unknown) => {
        attemptInFlight = false;
        consecutiveFailures += 1;
        // While suspended, scheduleRetry below is a deliberate no-op; the
        // log must not promise a retry that will not happen.
        console.error(
          `SpacetimeDB: connection to ${target} failed, ${
            idle.suspended()
              ? 'suspended for idle (input reconnects)'
              : `retrying in ${retryDelayMs}ms`
          }`,
          err,
        );
        scheduleRetry();
      });
  }

  attempt();

  /**
   * Idle suspension: stop the retry loop and close the connection (if any).
   * Suspending also while merely retrying is deliberate — an unattended tab
   * should not keep hammering a host that is down. The disconnect handler and
   * scheduleRetry both check idle.suspended(), so nothing rearms until the
   * activity listener resumes.
   */
  function suspendForIdle(): void {
    console.info(
      `SpacetimeDB: no user input for ${idleTimeoutMs}ms, suspending the connection (input resumes it)`,
    );
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
    onStatus('idle');
    // Invalidate a LIVE session's generation before cutting it: until the
    // socket finishes closing, the old DbConnection can still deliver row
    // and admission callbacks, and without the bump they would pass
    // wireSession's stale() and re-enter the world (join, prediction
    // restart) under an 'idle' status. A merely pending connect (conn not
    // yet assigned) has no wired session to stale, and keeping its
    // generation current lets a resume adopt it when it settles — attempt()
    // is single-flight, so that pending connect is the resume's only way
    // back in. One that settles while still suspended is discarded in
    // attempt()'s .then, and its close is swallowed by onDisconnect's
    // suspended() check.
    if (conn !== undefined) attemptGeneration += 1;
    // Tear the session down synchronously (mirroring dispose) instead of
    // waiting for the socket's close to report: a resume can start a newer
    // connect before that close lands, and the new session must never find
    // the old one half-alive (a lingering prediction would block its
    // handleOwnRow).
    const closing = conn;
    dropSession();
    closing?.disconnect();
  }

  const onActivity = (): void => {
    if (disposed) return;
    if (idle.activity(Date.now()) !== 'resume') return;
    console.info('SpacetimeDB: user input detected, resuming the connection');
    retryDelayMs = RETRY_INITIAL_MS;
    // Report the resume even when attempt() is a no-op because a connect is
    // still pending (we suspended mid-attempt): the banner must not keep
    // saying "idle" after the user is back. That pending connect settles
    // normally — its .then no longer sees a suspension, and its .catch
    // schedules a retry — so reporting is all that is left to do here.
    onStatus(everConnected ? 'reconnecting' : 'connecting');
    attempt();
  };
  for (const type of ACTIVITY_EVENTS) {
    window.addEventListener(type, onActivity, { capture: true, passive: true });
  }
  const idleTimer = setInterval(() => {
    if (disposed) return;
    if (idle.check(Date.now()) === 'suspend') suspendForIdle();
  }, IDLE_CHECK_INTERVAL_MS);

  /**
   * The shared shell of every user-triggered reducer call: drop with a
   * warning while disconnected, log a server refusal. Success never needs
   * handling here — it arrives as row events (see the Net method docs).
   */
  function callReducer(name: string, call: (c: DbConnection) => Promise<unknown>): void {
    if (!conn) {
      console.warn(`SpacetimeDB: not connected, ${name} dropped`);
      return;
    }
    call(conn).catch((err: unknown) => {
      console.error(`SpacetimeDB: ${name} rejected`, err);
    });
  }

  return {
    dispose() {
      disposed = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      clearInterval(idleTimer);
      for (const type of ACTIVITY_EVENTS) {
        window.removeEventListener(type, onActivity, { capture: true });
      }
      conn?.disconnect();
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
    setDisplayName(name) {
      callReducer('set_display_name', (c) => c.reducers.setDisplayName({ name }));
    },
    applyForMembership() {
      callReducer('apply_for_membership', (c) => c.reducers.applyForMembership({}));
    },
    memberAction(action, member) {
      callReducer(`${action}_member`, (c) => MEMBER_ACTION_CALLS[action](c, member));
    },
    setGuestsAllowed(allowed) {
      callReducer('set_guests_allowed', (c) => c.reducers.setGuestsAllowed({ allowed }));
    },
  };
}
