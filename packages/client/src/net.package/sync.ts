// fallow-ignore-file coverage-gaps -- wires a live SpacetimeDB connection to the game loop; needs a running host. The admission rules it acts on (decideAdmission, asMembership) are pure and unit-tested in @maple/shared
import {
  type Admission,
  admissionOf,
  asMembership,
  decideAdmission,
  type MemberRole,
  type MemberStatus,
  stateFromRow,
} from '@maple/shared';
import type { GameApp } from '../game.package';
import type { DbConnection } from '../module_bindings';
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

/** One space_member row, shaped for the admin UI. */
export interface SpaceMemberView {
  /** Hex identity: the stable key, and the handle for approve/remove calls. */
  idHex: string;
  /** The member's chosen name; undefined until they set one. */
  displayName: string | undefined;
  status: MemberStatus;
  role: MemberRole;
  /** When the membership was first filed, for a stable oldest-first order. */
  requestedAtMs: number;
}

/**
 * Everything membership-related the UI renders: this client's own admission
 * and standing, the space settings, and the member directory (public to all
 * clients; only admins get UI on top of it). Published on every
 * space_member / space_setting change. Not reset on disconnect — the last
 * known view holds until the next session republishes, and the UI gates
 * admin actions on the connection status instead.
 */
export interface SpaceView {
  admission: Admission;
  /** This client's own membership row, or undefined for guests. */
  self: SpaceMemberView | undefined;
  guestsAllowed: boolean;
  /** The whole directory, oldest membership first. */
  members: SpaceMemberView[];
}

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
   * Admin actions (approve_member / remove_member / set_guests_allowed).
   * The server re-checks that the sender is an acting admin; these methods
   * exist for the admin panel, whose gating is cosmetic. Success arrives as
   * space_member / space_setting row events (a fresh SpaceView); failures
   * only log, and the unchanged view is the visible outcome.
   */
  approveMember(memberIdHex: string): void;
  removeMember(memberIdHex: string): void;
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

  function wireSession(c: DbConnection, myIdHex: string): void {
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

    // ----- Admission (承認制 / ゲスト入場設定) -----

    // Whether this session has seen its own membership row: its later
    // absence then means an admin removed us (decideAdmission's `reapply`),
    // not that we are a guest.
    let wasMember = false;
    // The reapply reconnect must fire once, though several row deletions
    // (membership, account side effects, own player row) each re-evaluate.
    let reapplied = false;

    const guestsAllowedNow = (): boolean => {
      for (const row of c.db.spaceSetting.iter()) {
        if (row.id === 0) return row.guestsAllowed;
      }
      return true; // no settings row yet: the default is to allow guests
    };

    const ownMemberRow = () => {
      for (const row of c.db.spaceMember.iter()) {
        if (row.identity.toHexString() === myIdHex) return row;
      }
      return undefined;
    };

    const ownPlayerRow = (): PlayerRow | undefined => {
      for (const row of c.db.player.iter()) {
        if (row.identity.toHexString() === myIdHex) return row;
      }
      return undefined;
    };

    const buildSpaceView = (admission: Admission): SpaceView => {
      let self: SpaceMemberView | undefined;
      const members: SpaceMemberView[] = [];
      for (const row of c.db.spaceMember.iter()) {
        const view: SpaceMemberView = {
          idHex: row.identity.toHexString(),
          displayName: row.displayName,
          ...asMembership(row),
          requestedAtMs: Number(row.requestedAt.toMillis()),
        };
        members.push(view);
        if (view.idHex === myIdHex) self = view;
      }
      members.sort((a, b) => a.requestedAtMs - b.requestedAtMs);
      return { admission, self, guestsAllowed: guestsAllowedNow(), members };
    };

    /** The admission the current row cache implies for this client. */
    const currentDecision = () => {
      const memberRow = ownMemberRow();
      if (memberRow) wasMember = true;
      return decideAdmission({
        membership: memberRow && asMembership(memberRow),
        wasMember,
        guestsAllowed: guestsAllowedNow(),
      });
    };

    /**
     * The reapply reconnect, at most once per session: our membership
     * vanished (an admin removed us), so drop this connection and let the
     * fresh one file a new pending membership (decideAdmission's rationale).
     * Several row deletions in the same removal transaction (membership,
     * own player row) each re-evaluate admission, hence the guard.
     */
    const reapplyOnce = (): void => {
      if (reapplied) return;
      reapplied = true;
      console.info('SpacetimeDB: membership removed; reconnecting to re-apply');
      c.disconnect(); // onDisconnect drops the session and schedules the reconnect
    };

    /**
     * Enters the world once admission says so: resume the surviving own row
     * (a reload / blip within the retention window), or ask the server to
     * spawn one. Sitting behind the admission decision means a stale own
     * row can never start the simulation for a client that is not admitted.
     */
    const enterWorld = (): void => {
      if (prediction) return;
      const own = ownPlayerRow();
      if (own) {
        handleOwnRow(own);
        return;
      }
      joinWorld(c);
    };

    /**
     * Re-evaluates this client's admission against the current row cache,
     * reports it (which drives the waiting-room / guest-refusal UI and the
     * admin panel), and acts on it: enter when admitted and not already in
     * the world, reconnect when removed. Runs after every space_member /
     * space_setting row event and after our own player row is deleted, so
     * approvals, setting flips, kicks and retention sweeps all funnel
     * through this one rule.
     *
     * Consistency note: the SDK applies a whole transaction to the row
     * cache before dispatching any of its callbacks, so when a removal
     * deletes our player row and our membership together, this decision —
     * from whichever callback runs it first — already sees both gone and
     * lands on `reapply`, never on a rejoin-as-guest in between.
     */
    const applyAdmission = (): void => {
      const decision = currentDecision();
      onSpace(buildSpaceView(admissionOf(decision)));
      if (decision === 'join') {
        enterWorld();
      } else if (decision === 'reapply') {
        reapplyOnce();
      }
    };

    // Seed the remote players already in the world. Our own surviving row is
    // deliberately not resumed here: entering goes through applyAdmission
    // below (its enterWorld picks the row up), so the simulation can never
    // start for a client the admission rules would hold out.
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
        applyAdmission();
        return;
      }
      remoteViews.remove(idHex);
      gameApp.removeRemotePlayer(idHex);
    });

    // Membership and settings drive admission and the admin panel; every
    // change re-runs the one admission rule and republishes the view.
    c.db.spaceMember.onInsert((_ctx, _row) => {
      if (disposed) return;
      applyAdmission();
    });
    c.db.spaceMember.onUpdate((_ctx, _old, _row) => {
      if (disposed) return;
      applyAdmission();
    });
    c.db.spaceMember.onDelete((_ctx, _row) => {
      if (disposed) return;
      applyAdmission();
    });
    c.db.spaceSetting.onInsert((_ctx, _row) => {
      if (disposed) return;
      applyAdmission();
    });
    c.db.spaceSetting.onUpdate((_ctx, _old, _row) => {
      if (disposed) return;
      applyAdmission();
    });
    c.db.spaceSetting.onDelete((_ctx, _row) => {
      if (disposed) return;
      applyAdmission();
    });

    // The first decision: join (the pre-admission behavior), or hold and
    // show why. The subscription was applied before wireSession, so this
    // rules on real rows.
    applyAdmission();
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
      .then(({ conn: c, myIdHex }) => {
        if (disposed) {
          c.disconnect();
          return;
        }
        conn = c;
        everConnected = true;
        consecutiveFailures = 0;
        retryDelayMs = RETRY_INITIAL_MS;
        onStatus('connected');
        wireSession(c, myIdHex);
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

  /** Resolves an admin-panel handle back to the live row's Identity value. */
  function findMemberIdentity(c: DbConnection, memberIdHex: string) {
    for (const row of c.db.spaceMember.iter()) {
      if (row.identity.toHexString() === memberIdHex) return row.identity;
    }
    return undefined;
  }

  /** Shared shape of the three admin actions: guard, call, log a refusal. */
  function callAdminReducer(name: string, call: (c: DbConnection) => Promise<unknown>): void {
    if (!conn) {
      console.warn(`SpacetimeDB: not connected, ${name} dropped`);
      return;
    }
    call(conn).catch((err: unknown) => {
      console.error(`SpacetimeDB: ${name} rejected`, err);
    });
  }

  /** An admin action aimed at one member, resolved from its admin-panel handle. */
  function callMemberReducer(
    name: string,
    memberIdHex: string,
    call: (
      c: DbConnection,
      identity: NonNullable<ReturnType<typeof findMemberIdentity>>,
    ) => Promise<unknown>,
  ): void {
    callAdminReducer(name, (c) => {
      const identity = findMemberIdentity(c, memberIdHex);
      if (!identity) return Promise.resolve(); // already gone: the next view shows it
      return call(c, identity);
    });
  }

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
      if (!conn) {
        console.warn('SpacetimeDB: not connected, display name change dropped');
        return;
      }
      conn.reducers.setDisplayName({ name }).catch((err: unknown) => {
        console.error('SpacetimeDB: set_display_name rejected', err);
      });
    },
    approveMember(memberIdHex) {
      callMemberReducer('approve_member', memberIdHex, (c, identity) =>
        c.reducers.approveMember({ identity }),
      );
    },
    removeMember(memberIdHex) {
      callMemberReducer('remove_member', memberIdHex, (c, identity) =>
        c.reducers.removeMember({ identity }),
      );
    },
    setGuestsAllowed(allowed) {
      callAdminReducer('set_guests_allowed', (c) => c.reducers.setGuestsAllowed({ allowed }));
    },
  };
}
