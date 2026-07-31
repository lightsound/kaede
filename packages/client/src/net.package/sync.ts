// fallow-ignore-file coverage-gaps -- wires a live SpacetimeDB connection to the game loop; needs a running host. The admission rules it acts on are pure and unit-tested in @maple/shared (see admission.ts)
import { stateFromRow } from '@maple/shared';
import type { Identity } from 'spacetimedb';
import type { GameApp } from '../game.package';
import type { DbConnection } from '../module_bindings';
import { type SpaceView, wireAdmission } from './admission';
import { type AuthTokenGetter, connect, target } from './connection';
import { createPrediction } from './prediction';
import { createRemoteViews } from './remoteView';

/** The generated own/remote player row type (all columns). */
type PlayerRow =
  ReturnType<DbConnection['db']['player']['iter']> extends Iterator<infer R> ? R : never;

/** What the user should be told about the connection right now. */
export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting';

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
   * Admin actions (approve / reject / ban / unban / set_guests_allowed).
   * Targets are the identities carried by SpaceMemberView. The server
   * re-checks that the sender is an acting admin; these methods exist for
   * the admin panel, whose gating is cosmetic. Success arrives as
   * space_member / space_setting row events (a fresh SpaceView); failures
   * only log, and the unchanged view is the visible outcome.
   */
  approveMember(member: Identity): void;
  rejectMember(member: Identity): void;
  banMember(member: Identity): void;
  unbanMember(member: Identity): void;
  setGuestsAllowed(allowed: boolean): void;
}

/**
 * Wires the game to SpacetimeDB. The server is authoritative: the client sends
 * only inputs (batched through submit_inputs) and predicts locally, replaying
 * un-acked inputs whenever the authoritative row disagrees with our prediction.
 * Remote players are rendered interpolated INTERP_DELAY_MS in the past.
 *
 * Connection failures and drops are retried forever with exponential backoff;
 * `onStatus` keeps the UI informed. On reconnect the identity is resumed —
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
   * Arms the next attempt, at most once per failure. A failed connect both
   * rejects and closes the socket, so this is called twice for the same
   * failure; without the guard the backoff doubled twice per round (1s, 4s,
   * 16s...) and each extra timer was dropped from retryTimer unreferenced.
   */
  function scheduleRetry(): void {
    if (disposed || retryTimer !== undefined) return;
    onStatus(everConnected ? 'reconnecting' : 'connecting');
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      attempt();
    }, retryDelayMs);
    retryDelayMs = Math.min(retryDelayMs * 2, RETRY_MAX_MS);
  }

  function wireSession(c: DbConnection, myIdentity: Identity, myIdHex: string): void {
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
      isDisposed: () => disposed,
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

    // Every handler below refuses to run once disposed: the socket closes
    // asynchronously, so this session's row events can still be delivered
    // after dispose(), and acting on one would drive the destroyed Pixi app
    // (gameApp.start, prediction), re-install the e2e hook from the doomed
    // instance, or write to consumers shared with the replacement session
    // (onOwnName feeds the App's rename form). Guarding the event entry
    // points covers every side effect at once; the synchronous seeding above
    // needs no guard because dispose() cannot interleave with it.
    c.db.player.onInsert((_ctx, row) => {
      if (disposed) return;
      const idHex = row.identity.toHexString();
      if (idHex === myIdHex) {
        handleOwnRow(row);
        return;
      }
      recordRemote(idHex, row);
    });
    c.db.player.onUpdate((_ctx, _old, row) => {
      if (disposed) return;
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
      if (disposed) return;
      const idHex = row.identity.toHexString();
      if (idHex === myIdHex) {
        // Our row was reclaimed: by the retention sweep (a backgrounded tab
        // stops ticking and eventually looks abandoned), by the guest kick
        // that a guests-off flip performs, or by an admin removing us. Stop
        // predicting against a row that no longer exists, then let the
        // admission rule decide whether to re-join — the sweep case — or to
        // stay out and say why.
        prediction = undefined;
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

  function attempt(): void {
    if (disposed) return;
    onStatus(everConnected ? 'reconnecting' : 'connecting');
    connect(
      {
        onDisconnect() {
          if (disposed) return;
          console.warn('SpacetimeDB: connection dropped, reconnecting');
          dropSession();
          scheduleRetry();
        },
      },
      consecutiveFailures,
      getAuthToken,
    )
      .then(({ conn: c, myIdentity, myIdHex }) => {
        if (disposed) {
          c.disconnect();
          return;
        }
        conn = c;
        everConnected = true;
        consecutiveFailures = 0;
        retryDelayMs = RETRY_INITIAL_MS;
        onStatus('connected');
        wireSession(c, myIdentity, myIdHex);
      })
      // The overlay can only ever say "connecting", so without this the actual
      // cause (host not running, unknown database name, stale schema) never
      // reaches anyone. Naming the target makes the common misconfigurations
      // self-evident from the first line of the log.
      .catch((err: unknown) => {
        consecutiveFailures += 1;
        console.error(
          `SpacetimeDB: connection to ${target} failed, retrying in ${retryDelayMs}ms`,
          err,
        );
        scheduleRetry();
      });
  }

  attempt();

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

  /** One identity-targeted admin action, shaped as a Net method. */
  const memberAction =
    (name: string, invoke: (c: DbConnection, identity: Identity) => Promise<unknown>) =>
    (member: Identity): void =>
      callReducer(name, (c) => invoke(c, member));

  return {
    dispose() {
      disposed = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
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
    approveMember: memberAction('approve_member', (c, identity) =>
      c.reducers.approveMember({ identity }),
    ),
    rejectMember: memberAction('reject_member', (c, identity) =>
      c.reducers.rejectMember({ identity }),
    ),
    banMember: memberAction('ban_member', (c, identity) => c.reducers.banMember({ identity })),
    unbanMember: memberAction('unban_member', (c, identity) =>
      c.reducers.unbanMember({ identity }),
    ),
    setGuestsAllowed(allowed) {
      callReducer('set_guests_allowed', (c) => c.reducers.setGuestsAllowed({ allowed }));
    },
  };
}
