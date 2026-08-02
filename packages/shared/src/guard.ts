import {
  HEARTBEAT_MIN_AGE_MS,
  INPUT_BATCH_MAX_TICKS,
  MAX_TICK_BANK,
  OFFLINE_RETENTION_MS,
  TICK_ALLOWANCE_SLACK,
  TICK_RATE,
} from './constants';

const MICROS_PER_SECOND = 1_000_000n;
const TICK_RATE_BIG = BigInt(TICK_RATE);

/** Whole simulation ticks spanned by `micros` (truncated toward zero). */
function ticksFromMicros(micros: bigint): number {
  return Number((micros * TICK_RATE_BIG) / MICROS_PER_SECOND);
}

/** Microseconds spanned by `ticks` simulation ticks (truncated toward zero). */
function microsFromTicks(ticks: number): bigint {
  return (BigInt(ticks) * MICROS_PER_SECOND) / TICK_RATE_BIG;
}

/**
 * Why a batch was refused. `stale-tick` is the normal resend/duplicate path.
 * `gap-ahead-of-row` is a batch claiming to start past the row's applied
 * tick while the row is NOT quiescent: an honest client only skips ticks
 * from a fully-acked quiescent state (evaluateSendWindow), so the elided
 * ticks would have moved the player — refusing keeps the gap acceptance
 * sound.
 */
export type BatchRejectReason =
  | 'oversized-batch'
  | 'stale-tick'
  | 'gap-ahead-of-row'
  | 'rate-limited';

export type BatchVerdict =
  | {
      ok: true;
      kind: 'apply';
      /** The advanced token-bucket marker to persist on the player_guard row. */
      allowanceMicros: bigint;
    }
  | {
      ok: true;
      kind: 'heartbeat';
      /**
       * Whether to rewrite the row (updatedAt refresh). False while the row
       * is younger than HEARTBEAT_MIN_AGE_MS, so heartbeat spam cannot
       * multiply row updates (= egress to every subscriber).
       */
      refresh: boolean;
    }
  | { ok: false; reason: BatchRejectReason };

/**
 * Pure admission check for one submit_inputs call, shared so the server
 * reducer stays a thin wrapper and the guard itself is unit-testable.
 *
 * An EMPTY batch is a heartbeat: the idle-suppression protocol stops the
 * input stream entirely while a player is quiescent (evaluateSendWindow),
 * so a connected-but-still client proves liveness with an occasional empty
 * call instead of a stream of no-op ticks — that is what keeps its row from
 * expiring (isExpiredRow) without schema or reducer-signature changes.
 *
 * A batch may START PAST the row's applied tick (startTick > rowTick) iff
 * the row is quiescent: the gap is exactly the ticks the sender's send gate
 * skipped, all empty inputs on a fixpoint state (isQuiescent), so applying
 * the batch from the row state and fast-forwarding the tick counter yields
 * the same result as replaying the elided ticks would have. The pre-idle-
 * suppression guard required startTick === rowTick (連続性前提); this is
 * the redesigned rule (ROADMAP Phase 2).
 *
 * Rate limiting is a token bucket over wall-clock time. `allowanceMicros`
 * is the point in time up to which the player's applied ticks are "paid
 * for": ticks accrue at TICK_RATE between that marker and `nowMicros`, and
 * accepting a batch advances the marker by the batch's duration (gap ticks
 * cost nothing — they apply no input and run no physics). The accrued bank
 * is capped at MAX_TICK_BANK so a client that idles (or lags) for a long
 * time can never build up an unbounded backlog and replay it as a burst of
 * movement. The marker may advance past `nowMicros` by up to
 * TICK_ALLOWANCE_SLACK ticks, absorbing flush-cadence and clock jitter;
 * beyond that, batches are refused until real time catches up, which caps
 * sustained input rate at exactly the simulation tick rate.
 */
export function evaluateInputBatch(batch: {
  /** Number of input ticks in the batch; 0 is a heartbeat. */
  batchLength: number;
  /** Tick the batch claims to start after; row tick, or past it (gap). */
  startTick: number;
  /** Ticks the server has applied so far (row.tick). */
  rowTick: number;
  /** Whether the row's state is a fixpoint of empty input (isQuiescent). */
  rowQuiescent: boolean;
  /** Time since the row last changed (ms); gates heartbeat refreshes. */
  rowAgeMs: number;
  /** Token-bucket marker persisted on the player_guard row (micros since Unix epoch). */
  allowanceMicros: bigint;
  /** Server wall clock (micros since Unix epoch). */
  nowMicros: bigint;
}): BatchVerdict {
  const { batchLength, startTick, rowTick, nowMicros } = batch;
  if (batchLength === 0) {
    return { ok: true, kind: 'heartbeat', refresh: batch.rowAgeMs >= HEARTBEAT_MIN_AGE_MS };
  }
  if (batchLength > INPUT_BATCH_MAX_TICKS) return { ok: false, reason: 'oversized-batch' };
  if (startTick < rowTick) return { ok: false, reason: 'stale-tick' };
  if (startTick > rowTick && !batch.rowQuiescent) {
    return { ok: false, reason: 'gap-ahead-of-row' };
  }

  // Cap the accrued bank by pulling the marker forward if it fell too far behind.
  let marker = batch.allowanceMicros;
  const bankCapMarker = nowMicros - microsFromTicks(MAX_TICK_BANK);
  if (marker < bankCapMarker) marker = bankCapMarker;

  const bank = ticksFromMicros(nowMicros - marker);
  if (batchLength > bank + TICK_ALLOWANCE_SLACK) return { ok: false, reason: 'rate-limited' };

  return { ok: true, kind: 'apply', allowanceMicros: marker + microsFromTicks(batchLength) };
}

/**
 * True once a player row has sat unchanged past its retention window and may
 * be swept. `ageMs` is the time since the row last changed.
 *
 * The `online` flag is deliberately not consulted. A live client rewrites
 * its row with every accepted input batch while moving, and proves liveness
 * with heartbeats (HEARTBEAT_INTERVAL_MS, well inside this window) while
 * the send gate keeps it silent — so any row this old is abandoned: either
 * a clean disconnect (kept for the window so a reload resumes the same
 * character) or a host that died before client_disconnected could run,
 * leaving the row stranded at `online = true`. A module cannot enumerate
 * live connections, so age is the only evidence available, and gating the
 * sweep on `online` would let stranded rows haunt the world forever.
 */
export function isExpiredRow(ageMs: number): boolean {
  return ageMs > OFFLINE_RETENTION_MS;
}
