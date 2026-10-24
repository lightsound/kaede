// fallow-ignore-file coverage-gaps -- wires live SpacetimeDB player rows to the game and the remote views; needs a running host. What it acts on is pure and unit-tested: the prediction (prediction.ts) and the remote interpolation (remoteView.ts)
import { mapFor, type StatusView, stateFromRow, statusLabel } from '@kaede/shared';
import type { Identity } from 'spacetimedb';
import type { GameApp } from '../game.package';
import type { DbConnection } from '../module_bindings';
import { type Connected, subscribeMapRows } from './connection';
import { cachedStateGesture } from './gestureFeed';
import { createPrediction } from './prediction';
import type { createRemoteViews } from './remoteView';
import type { RowOf } from './rows';
import { cachedStatusView } from './statusFeed';
import { cachedZoneTag } from './zoneFeed';

/** The generated own/remote player row type (all columns). */
type PlayerRow = RowOf<'player'>;

/** The generated player_name row type (the display name split off the hot row). */
type PlayerNameRow = RowOf<'playerName'>;

/**
 * The own simulation's state, in one object startNet holds across
 * sessions: its tick callback (registered once, outside any session) and
 * the heartbeat read it. The values are per session. startNet sets them on
 * session entry, clears them when the session drops and marks a portal
 * call pending (maybeEnterPortal); the session's player feed starts, stops
 * and re-maps the simulation. One object, so both files read and write the
 * same cells.
 */
export interface OwnSim {
  /**
   * Prediction lives per connection: it is created once the authoritative
   * own row is known, and torn down (with the remote views) when the
   * connection drops. The local sim keeps running while offline;
   * reconnecting snaps it back to the authoritative row.
   */
  prediction: ReturnType<typeof createPrediction> | undefined;
  /**
   * The map the live session is scoped to: which player rows are
   * subscribed (subscribeMapRows), which geometry the prediction replays
   * on, and which map GameApp renders. Session state, but held across
   * sessions because the tick callback reads it for portal-intent
   * detection. Updated on session entry and by switchMap on every
   * teleport.
   */
  currentMapId: number;
  /**
   * Set while an enter_portal call is in flight; cleared when the own
   * row's map flips (switchMap) or PORTAL_PENDING_TIMEOUT_MS passes (the
   * rule and its rationale live in decidePortalCall, @kaede/shared).
   */
  portalPendingAtMs: number | undefined;
}

/** What the player feed needs from the net stack that owns it (startNet). */
export interface PlayerFeedDeps {
  sim: OwnSim;
  gameApp: GameApp;
  /** The remote players' interpolated views, kept across sessions (remoteView.ts). */
  remoteViews: ReturnType<typeof createRemoteViews>;
  /** True once this session's events must be ignored (see wireSession). */
  isStale(): boolean;
  /** startNet's single path for own-name changes (see publishOwnName). */
  publishOwnName(name: string | undefined): void;
  /** startNet's single path for own-status changes (see publishOwnStatus). */
  publishOwnStatus(view: StatusView): void;
  /** Sends one liveness heartbeat on `c` (startNet's sendHeartbeat). */
  sendHeartbeat(c: DbConnection): void;
  /** Sends one input batch for the prediction (startNet's sendBatch). */
  sendBatch(startTick: number, packed: Uint8Array): void;
  /** Counts one player row event (the dev-only playerRowUpdates stat). */
  countRowUpdate(): void;
  /** Re-pushes the zone feed's per-map projection after a map switch. */
  refreshZones(): void;
}

/**
 * One session's player wiring. enterWorld is admission's hook, run
 * whenever admission lets this client in; seedRemotes and wireRowEvents
 * are steps wireSession runs, in that order.
 */
export interface PlayerFeed {
  /** Resumes the surviving own row, or asks the server to spawn one. */
  enterWorld(): void;
  /** Seeds the remote players already in the world. */
  seedRemotes(): void;
  /** Wires the player / player_name row events. */
  wireRowEvents(admission: { reevaluate(): void }): void;
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
 * Builds one session's player wiring: the own row starts, acknowledges
 * and re-maps the local simulation, remote rows feed the interpolated
 * views, and player_name rows feed both sides' labels. Building it has no
 * side effects; wireSession runs the returned steps.
 */
export function createPlayerFeed(settled: Connected, deps: PlayerFeedDeps): PlayerFeed {
  const { conn: c, myIdentity, myIdHex } = settled;
  const { sim, gameApp, remoteViews } = deps;

  // The map-scoped half of the player subscription (see connection.ts),
  // swapped by switchMap on every teleport.
  let mapSub = settled.mapSub;

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
    // The ①c pose inputs ride the label like the status seed: a view
    // (re)created for a sitting or busy player must start posed.
    gesture: cachedStateGesture(c, identity),
    availability: cachedStatusView(c, identity).availability,
  });

  // Our row appears (or already exists, when resuming an identity) via join
  // below. Start/refresh the simulation from that authoritative state.
  const handleOwnRow = (row: PlayerRow) => {
    if (sim.prediction) return;
    deps.publishOwnName(nameOf(row.identity));
    // The seed half of the status display (a status is state, so unlike
    // reactions the subscribed cache restores it on entry/reload); row
    // events keep it fresh from here (wireStatuses). The own state
    // gesture seeds the same way (①c — a reload must restore the pose).
    deps.publishOwnStatus(cachedStatusView(c, row.identity));
    gameApp.patchLocalLabel({ gesture: cachedStateGesture(c, row.identity) });
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
    // per entry. Sending also seeds the heartbeat clock (startNet's
    // lastSendMs).
    deps.sendHeartbeat(c);
    sim.prediction = createPrediction(
      {
        sendBatch: deps.sendBatch,
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
   * the map-scoped subscription itself — the destination map is
   * subscribed BEFORE the origin is dropped, so there is no window with
   * neither (the own row, covered by the identity query throughout,
   * never flickers either way — subscription overlap is refcounted).
   * Since 増分④ that subscription also carries the map-scoped chat
   * (subscribeMapRows), so the origin map's lines leave the log with its
   * players — the accepted consequence of scoping the history.
   */
  const switchMap = (row: PlayerRow): void => {
    sim.currentMapId = row.mapId;
    sim.portalPendingAtMs = undefined;
    sim.prediction = undefined;
    remoteViews.clear();
    gameApp.clearRemotePlayers();
    gameApp.setMap(mapFor(row.mapId));
    // The zone layer is a per-map projection like the map geometry; the
    // occupancy tags re-derive with it.
    deps.refreshZones();
    handleOwnRow(row);
    const outgoing = mapSub;
    mapSub = subscribeMapRows(c, row.mapId, () => {
      // The destination's rows just landed as insert events (recordRemote
      // picked them up). A stale session's socket is gone or superseded,
      // and its handles die with the connection — only a live session
      // needs to drop the origin's rows.
      if (!deps.isStale()) outgoing.unsubscribe();
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
    if (row.mapId !== sim.currentMapId) {
      switchMap(row);
      return;
    }
    if (!row.online) deps.sendHeartbeat(c);
    sim.prediction?.onAck(stateFromRow(row), row.tick, performance.now());
  };

  // Offline rows linger server-side for the retention window (so their owner
  // can resume) but should not be visible in the world. Rows from another
  // map are dropped the same way: the subscription swap makes them rare
  // (the origin map's rows delete when its query unsubscribes), but during
  // the overlap window both maps' rows flow, and a remote player's own
  // teleport reaches us as an update whose mapId no longer matches.
  const recordRemote = (idHex: string, row: PlayerRow) => {
    if (!row.online || row.mapId !== sim.currentMapId) {
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
      deps.publishOwnName(row.name);
      return;
    }
    remoteViews.patchLabel(idHex, { name: row.name });
  };

  /**
   * Enters the world once admission says so: resume the surviving own row
   * (a reload / blip within the retention window), or ask the server to
   * spawn one. Sitting behind the admission decision means a stale own
   * row can never start the simulation for a client that is not admitted.
   */
  const enterWorld = (): void => {
    if (sim.prediction) return;
    const own = c.db.player.identity.find(myIdentity);
    if (own) {
      // A resumed row may sit on another map than the one this session
      // subscribed at connect time (another device of the same identity
      // teleporting in between): route through the map switch first.
      if (own.mapId !== sim.currentMapId) switchMap(own);
      else handleOwnRow(own);
      return;
    }
    joinWorld(c);
  };

  // The remote players already in the world. Our own surviving row is
  // deliberately not resumed here: entering goes through the admission
  // re-evaluation (its enterWorld picks the row up), so the simulation can
  // never start for a client the admission rules would hold out.
  const seedRemotes = (): void => {
    for (const row of c.db.player.iter()) {
      const idHex = row.identity.toHexString();
      if (idHex !== myIdHex) recordRemote(idHex, row);
    }
  };

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
  const wireRowEvents = (admission: { reevaluate(): void }): void => {
    c.db.player.onInsert((_ctx, row) => {
      if (deps.isStale()) return;
      deps.countRowUpdate();
      const idHex = row.identity.toHexString();
      if (idHex === myIdHex) {
        // A fresh spawn lands on the session's map, but a re-join racing a
        // sweep (or another device) can insert the own row elsewhere.
        if (row.mapId !== sim.currentMapId) switchMap(row);
        else handleOwnRow(row);
        return;
      }
      recordRemote(idHex, row);
    });
    c.db.player.onUpdate((_ctx, _old, row) => {
      if (deps.isStale()) return;
      deps.countRowUpdate();
      const idHex = row.identity.toHexString();
      if (idHex === myIdHex) applyOwnUpdate(row);
      else recordRemote(idHex, row);
    });
    c.db.playerName.onInsert((_ctx, row) => {
      if (deps.isStale()) return;
      applyName(row);
    });
    c.db.playerName.onUpdate((_ctx, _old, row) => {
      if (deps.isStale()) return;
      applyName(row);
    });
    c.db.player.onDelete((_ctx, row) => {
      if (deps.isStale()) return;
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
        sim.prediction = undefined;
        gameApp.stop();
        // No row again until a re-join lands; disable the rename form so a
        // submit cannot race into the server's no-target refusal.
        deps.publishOwnName(undefined);
        admission.reevaluate();
        return;
      }
      remoteViews.remove(idHex);
      gameApp.removeRemotePlayer(idHex);
    });
  };

  return { enterWorld, seedRemotes, wireRowEvents };
}
