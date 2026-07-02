import { INPUT_BATCH_MAX_TICKS, MAX_TICK_BANK, TICK_ALLOWANCE_SLACK, TICK_RATE } from './constants';

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

/** Why a batch was refused. `stale-tick` is the normal resend/duplicate path. */
export type BatchRejectReason = 'empty-batch' | 'oversized-batch' | 'stale-tick' | 'rate-limited';

export type BatchVerdict =
  | {
      ok: true;
      /** The advanced token-bucket marker to persist on the player row. */
      allowanceMicros: bigint;
    }
  | { ok: false; reason: BatchRejectReason };

/**
 * Pure admission check for one input batch, shared so the server reducer stays
 * a thin wrapper and the guard itself is unit-testable.
 *
 * Rate limiting is a token bucket over wall-clock time. `allowanceMicros` is
 * the point in time up to which the player's applied ticks are "paid for":
 * ticks accrue at TICK_RATE between that marker and `nowMicros`, and accepting
 * a batch advances the marker by the batch's duration. The accrued bank is
 * capped at MAX_TICK_BANK so a client that idles (or lags) for a long time can
 * never build up an unbounded backlog and replay it as a burst of movement.
 * The marker may advance past `nowMicros` by up to TICK_ALLOWANCE_SLACK ticks,
 * absorbing flush-cadence and clock jitter; beyond that, batches are refused
 * until real time catches up, which caps sustained input rate at exactly the
 * simulation tick rate.
 */
export function evaluateInputBatch(batch: {
  /** Number of input ticks in the batch. */
  batchLength: number;
  /** Tick the batch claims to start after; must equal the row's applied tick. */
  startTick: number;
  /** Ticks the server has applied so far (row.tick). */
  rowTick: number;
  /** Token-bucket marker persisted on the row (micros since Unix epoch). */
  allowanceMicros: bigint;
  /** Server wall clock (micros since Unix epoch). */
  nowMicros: bigint;
}): BatchVerdict {
  const { batchLength, startTick, rowTick, nowMicros } = batch;
  if (batchLength === 0) return { ok: false, reason: 'empty-batch' };
  if (batchLength > INPUT_BATCH_MAX_TICKS) return { ok: false, reason: 'oversized-batch' };
  if (startTick !== rowTick) return { ok: false, reason: 'stale-tick' };

  // Cap the accrued bank by pulling the marker forward if it fell too far behind.
  let marker = batch.allowanceMicros;
  const bankCapMarker = nowMicros - microsFromTicks(MAX_TICK_BANK);
  if (marker < bankCapMarker) marker = bankCapMarker;

  const bank = ticksFromMicros(nowMicros - marker);
  if (batchLength > bank + TICK_ALLOWANCE_SLACK) return { ok: false, reason: 'rate-limited' };

  return { ok: true, allowanceMicros: marker + microsFromTicks(batchLength) };
}
