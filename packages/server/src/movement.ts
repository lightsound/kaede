// fallow-ignore-file coverage-gaps -- reducers only run inside a SpacetimeDB module host, so no unit test can import this file; the rules worth testing (input admission, replay, portal geometry, rate limit) are delegated to evaluateInputBatch / replayInputs / evaluatePortalUse / evaluatePortalSend in @kaede/shared and unit-tested there

// The movement reducers: what changes a player's position once it is in
// the world — the input batches (submit_inputs) and the portal teleport
// (enter_portal) — with the side effects every authoritative move carries
// (the group-occupancy pass, the gesture clear).
import {
  type AcceptedBatchVerdict,
  type BatchRejectReason,
  evaluateInputBatch,
  evaluatePortalSend,
  evaluatePortalUse,
  isQuiescent,
  mapFor,
  replayInputs,
  stateFromRow,
} from '@kaede/shared';
import { t } from 'spacetimedb/server';
import { syncGroupOccupancy } from './occupancy';
import { chargeSendAllowance } from './sendAllowance';
import { spacetimedb } from './tables';
import {
  type Ctx,
  findAdmittedWorldRows,
  type SenderIdentity,
  syncNameOnline,
  type WorldRows,
} from './world';

/**
 * Records why a batch was refused. `stale-tick` is the resend watchdog's normal
 * duplicate path, so it is not noteworthy. `gap-ahead-of-row` is logged: an
 * honest client only ever creates a gap from a fully-acked quiescent state
 * (evaluateSendWindow), so a moving-row gap means a lost batch raced the
 * send gate or someone is probing.
 */
function logRejection(
  reason: BatchRejectReason,
  sender: string,
  startTick: number,
  length: number,
  rowTick: number,
): void {
  if (reason === 'stale-tick') return;
  console.warn(
    `submit_inputs rejected (${reason}): sender=${sender} startTick=${startTick} len=${length} rowTick=${rowTick}`,
  );
}

// Server-authoritative movement: clients send only inputs, the server replays
// them through the same shared physics. Position cannot change any other way.
// Admission (batch size, gap/ordering, token-bucket rate limit, heartbeat
// classification) lives in the pure evaluateInputBatch so it is unit-tested
// in @kaede/shared. Two idle-suppression cases ride on this one reducer so
// no new reducer (= no bindings regeneration) is needed (ROADMAP Phase 2):
// - An EMPTY batch is a heartbeat: a quiescent client sends no input ticks
//   at all, so this is how its row's updatedAt keeps moving and the
//   retention sweep (isExpiredRow) knows it is still alive.
// - startTick may run PAST row.tick when the row is quiescent: the gap is
//   the empty ticks the sender's send gate skipped, provably no-ops, so the
//   tick counter fast-forwards to startTick without replaying them.
export const submitInputs = spacetimedb.reducer(
  { startTick: t.u32(), inputs: t.array(t.u8()) },
  (ctx, { startTick, inputs }) => {
    // Not in the world, or no longer admitted (findAdmittedWorldRows
    // reclaims the row in that case): silently drop the batch — movement
    // needs no loud refusal, so both verdict reasons read the same here.
    const found = findAdmittedWorldRows(ctx);
    if (!found.ok) return;
    const { row, guard } = found.rows;

    const verdict = evaluateInputBatch({
      batchLength: inputs.length,
      startTick,
      rowTick: row.tick,
      rowQuiescent: isQuiescent(stateFromRow(row)),
      rowAgeMs: ctx.timestamp.since(row.updatedAt).millis,
      rowOnline: row.online,
      allowanceMicros: guard.allowanceMicros,
      nowMicros: ctx.timestamp.microsSinceUnixEpoch,
    });
    if (verdict.kind === 'rejected') {
      logRejection(verdict.reason, ctx.sender.toHexString(), startTick, inputs.length, row.tick);
      return;
    }

    applyAcceptedBatch(ctx, found.rows, startTick, inputs, verdict);
  },
);

/**
 * Applies an accepted submit_inputs verdict — a heartbeat's liveness refresh,
 * or a replayed input batch. Split out of the reducer to keep that uncovered
 * arrow under the CRAP budget fallow enforces (the backfillAccountName
 * precedent); the decisions themselves live in evaluateInputBatch,
 * unit-tested in @kaede/shared.
 */
function applyAcceptedBatch(
  ctx: Ctx,
  rows: WorldRows,
  startTick: number,
  inputs: number[],
  verdict: AcceptedBatchVerdict,
): void {
  const { row, guard, nameRow } = rows;
  if (verdict.kind === 'heartbeat') {
    // Liveness only: no replay, no guard update. `refresh` covers both the
    // periodic keep-alive (only once the row has aged past
    // HEARTBEAT_MIN_AGE_MS, bounding how often spam could rewrite the row —
    // = egress to every subscriber) and the reconnect announcement that
    // flips an offline resumed row back to visible.
    if (verdict.refresh) {
      ctx.db.player.identity.update({ ...row, online: true, updatedAt: ctx.timestamp });
      syncNameOnline(ctx, nameRow, true);
    }
    return;
  }

  // The replay runs on the map the row is on: enter_portal is the only map
  // transition, so a batch never crosses maps mid-replay.
  const s = replayInputs(stateFromRow(row), inputs, mapFor(row.mapId).collision);

  ctx.db.playerGuard.identity.update({ ...guard, allowanceMicros: verdict.allowanceMicros });
  ctx.db.player.identity.update({
    ...row,
    x: s.x,
    y: s.y,
    vx: s.vx,
    vy: s.vy,
    facing: s.facing,
    onGround: s.onGround,
    rope: s.rope,
    // startTick, not row.tick: an accepted quiescent gap fast-forwards the
    // counter over the elided empty ticks (startTick === row.tick when
    // there is no gap).
    tick: startTick + inputs.length,
    online: true, // a stale disconnect event may have raced us; inputs prove liveness
    updatedAt: ctx.timestamp,
  });
  syncNameOnline(ctx, nameRow, true);
  // Group occupancy follows the authoritative position (ROADMAP Phase 3
  // 増分②③ — the server-side judgment; see zone.ts in @kaede/shared for
  // why not the portal pattern). The heartbeat branch above skips it: no
  // movement, no transition to rule on. The gesture clear rides the same
  // spot (Phase 5 ①c 「歩き出したら解除」 — see clearGestureOnMove).
  clearGestureOnMove(ctx, ctx.sender, { x: row.x, y: row.y }, { x: s.x, y: s.y });
  syncGroupOccupancy(ctx, ctx.sender, { x: s.x, y: s.y }, row.mapId);
}

/**
 * Clears the mover's pose gesture when the authoritative position actually
 * changed (Phase 5 ①c —「歩き出したら解除」, MapleStory's sit rule). Runs
 * beside syncGroupOccupancy on every authoritative-movement write path
 * (the accepted-batch replay, enter_portal), which is what makes the rule
 * server-authoritative: a late joiner can never see a walked-away sitter
 * still sitting, and no hostile client can keep a stale pose by omitting
 * a clear call. Exact comparison, no epsilon: the deterministic replay of
 * a quiescent player reproduces the position bit-for-bit, and any real
 * input moves it. Cost: one PK lookup per accepted batch — only the
 * delete is conditional on it, and only movers with a live gesture row
 * pay the delete.
 */
function clearGestureOnMove(
  ctx: Ctx,
  identity: SenderIdentity,
  before: { x: number; y: number },
  after: { x: number; y: number },
): void {
  if (before.x === after.x && before.y === after.y) return;
  if (ctx.db.gesture.identity.find(identity) !== null) {
    ctx.db.gesture.identity.delete(identity);
  }
}

// Teleports the sender through a portal it is standing in (ROADMAP Phase 3
// ポータル移動): the one write path that changes a player's mapId. The
// client flushes its pending inputs before calling (sync.ts), so the
// deterministic replay has already put the row exactly where the sender's
// prediction stood and evaluatePortalUse (pure, unit-tested in
// @kaede/shared) re-checks the same geometry the client's intent detection
// used — no position slack, no trust in the client's resolution. The
// landing pose is standing-still at the target (a quiescent fixpoint,
// fixed by the shared map unit tests), so the traveler's send gate can go
// silent immediately.
//
// `tick` advances by ONE even though a teleport applies no inputs: it is
// the fence that invalidates in-flight input batches. The client keeps
// ticking on the ORIGIN map until the teleported row round-trips back
// (its prediction is torn down only then — sync.ts switchMap), so a flush
// cadence can land origin-map inputs here after the teleport; with the
// old tick they replayed from the landing spot on the DESTINATION map
// (walking the traveler around a map its inputs never saw), while a
// bumped tick makes every batch minted against the pre-teleport counter
// refuse as stale-tick — the resend watchdog's silent duplicate path, no
// log noise. The client's fresh prediction starts from this row's tick,
// so it is never out of step.
//
// Refusals follow the movement rule (silent drop + warn) rather than
// chat's loud SenderError: a stale double-press racing the first teleport
// is the common refusal, and honest clients cannot act on the error
// anyway. The rate charge (portal_guard) still throws — nothing is
// written before it, and a rate-limited spammer deserves the log line.
export const enterPortal = spacetimedb.reducer({ portalId: t.u32() }, (ctx, { portalId }) => {
  const found = findAdmittedWorldRows(ctx);
  if (!found.ok) return;
  const { row, nameRow } = found.rows;
  const verdict = evaluatePortalUse({
    state: stateFromRow(row),
    portalId,
    map: mapFor(row.mapId),
  });
  if (!verdict.ok) {
    console.warn(
      `enter_portal rejected (${verdict.reason}): sender=${ctx.sender.toHexString()} mapId=${row.mapId} portalId=${portalId}`,
    );
    return;
  }
  chargeSendAllowance(ctx, ctx.db.portalGuard, evaluatePortalSend, 'enter_portal');
  ctx.db.player.identity.update({
    ...row,
    mapId: verdict.target.mapId,
    x: verdict.target.x,
    y: verdict.target.y,
    vx: 0,
    vy: 0,
    onGround: true,
    rope: -1,
    tick: row.tick + 1, // the in-flight-batch fence — see the doc comment
    online: true, // using a portal proves liveness (the accepted-batch rule)
    updatedAt: ctx.timestamp,
  });
  syncNameOnline(ctx, nameRow, true);
  // A teleport moves the authoritative position like any movement: the
  // occupancy pass leaves the origin map's zone — or huddle: a huddle
  // lives on its founding map, so teleporting off it is leaving
  // (keepsHuddleMembership) — and rules on the landing spot (an admin may
  // well place a zone over a portal mouth). The gesture clears
  // UNCONDITIONALLY (Phase 5 ①c), not via clearGestureOnMove's coordinate
  // comparison: a teleport is a departure whatever the numbers say, and a
  // portal whose landing happened to coincide with the departure point
  // would otherwise carry a seated pose across maps (review finding).
  ctx.db.gesture.identity.delete(ctx.sender);
  syncGroupOccupancy(ctx, ctx.sender, verdict.target, verdict.target.mapId);
});
