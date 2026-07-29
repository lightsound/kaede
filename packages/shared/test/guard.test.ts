import { describe, expect, it } from 'vitest';
import {
  evaluateInputBatch,
  INPUT_BATCH_MAX_TICKS,
  isExpiredRow,
  MAX_TICK_BANK,
  OFFLINE_RETENTION_MS,
  TICK_ALLOWANCE_SLACK,
  TICK_RATE,
} from '../src';

const MICROS_PER_TICK = 1_000_000 / TICK_RATE;

/** Micros since epoch after `ticks` ticks of wall-clock time (exact at 60Hz is fractional; truncate). */
const micros = (ticks: number): bigint => BigInt(Math.floor(ticks * MICROS_PER_TICK));

/** An evaluateInputBatch argument with sane defaults, overridable per test. */
function batch(overrides: Partial<Parameters<typeof evaluateInputBatch>[0]>) {
  return evaluateInputBatch({
    batchLength: 6,
    startTick: 0,
    rowTick: 0,
    allowanceMicros: 0n,
    nowMicros: micros(6),
    ...overrides,
  });
}

describe('evaluateInputBatch', () => {
  it('rejects an empty batch', () => {
    expect(batch({ batchLength: 0 })).toEqual({ ok: false, reason: 'empty-batch' });
  });

  it('rejects a batch above INPUT_BATCH_MAX_TICKS', () => {
    expect(batch({ batchLength: INPUT_BATCH_MAX_TICKS + 1 })).toEqual({
      ok: false,
      reason: 'oversized-batch',
    });
  });

  it('rejects a duplicate/out-of-order batch (startTick mismatch)', () => {
    expect(batch({ startTick: 5, rowTick: 6 })).toEqual({ ok: false, reason: 'stale-tick' });
    expect(batch({ startTick: 7, rowTick: 6 })).toEqual({ ok: false, reason: 'stale-tick' });
  });

  it('accepts the normal cadence: batch duration matches elapsed wall clock', () => {
    const v = batch({ batchLength: 6, allowanceMicros: 0n, nowMicros: micros(6) });
    expect(v.ok).toBe(true);
  });

  it('advances the marker by exactly the accepted batch duration', () => {
    const v = batch({ batchLength: 6, allowanceMicros: micros(100), nowMicros: micros(107) });
    if (!v.ok) throw new Error('expected ok');
    expect(v.allowanceMicros).toBe(micros(100) + BigInt(Math.floor(6 * MICROS_PER_TICK)));
  });

  it('allows a burst up to TICK_ALLOWANCE_SLACK ahead of the wall clock', () => {
    // Marker == now: no accrued bank, only slack is available.
    const now = micros(1000);
    const v = batch({
      batchLength: TICK_ALLOWANCE_SLACK,
      allowanceMicros: now,
      nowMicros: now,
    });
    expect(v.ok).toBe(true);
  });

  it('rejects once the slack is spent, until real time catches up', () => {
    const now = micros(1000);
    // Marker already TICK_ALLOWANCE_SLACK ticks in the future: nothing left.
    const ahead = now + BigInt(Math.ceil(TICK_ALLOWANCE_SLACK * MICROS_PER_TICK));
    expect(batch({ batchLength: 1, allowanceMicros: ahead, nowMicros: now })).toEqual({
      ok: false,
      reason: 'rate-limited',
    });
    // One tick of wall clock later, one tick of input is allowed again.
    const later = now + BigInt(Math.ceil((TICK_ALLOWANCE_SLACK + 1) * MICROS_PER_TICK));
    expect(batch({ batchLength: 1, allowanceMicros: ahead, nowMicros: later }).ok).toBe(true);
  });

  it('caps the idle bank: a long-idle player cannot replay more than bank + slack', () => {
    // One hour idle, then hammer max-size batches with no wall-clock progress.
    const now = micros(3600 * TICK_RATE);
    let marker = 0n;
    let accepted = 0;
    for (let i = 0; i < 1000; i++) {
      const v = evaluateInputBatch({
        batchLength: INPUT_BATCH_MAX_TICKS,
        startTick: accepted,
        rowTick: accepted,
        allowanceMicros: marker,
        nowMicros: now,
      });
      if (!v.ok) break;
      marker = v.allowanceMicros;
      accepted += INPUT_BATCH_MAX_TICKS;
    }
    expect(accepted).toBeGreaterThan(0);
    expect(accepted).toBeLessThanOrEqual(MAX_TICK_BANK + TICK_ALLOWANCE_SLACK);
  });

  it('sustains exactly real-time rate in steady state', () => {
    // Simulate 10 seconds of a client flushing 6 ticks every 6 ticks of wall
    // clock: every batch must be accepted (no false positives).
    let marker = 0n;
    let tick = 0;
    for (let flush = 1; flush <= 100; flush++) {
      const v = evaluateInputBatch({
        batchLength: 6,
        startTick: tick,
        rowTick: tick,
        allowanceMicros: marker,
        nowMicros: micros(flush * 6),
      });
      if (!v.ok) throw new Error(`flush ${flush} rejected: ${v.reason}`);
      marker = v.allowanceMicros;
      tick += 6;
    }
    expect(tick).toBe(600);
  });
});

describe('isExpiredRow', () => {
  it('keeps a row until the retention window has fully elapsed', () => {
    expect(isExpiredRow(0)).toBe(false);
    expect(isExpiredRow(OFFLINE_RETENTION_MS - 1)).toBe(false);
    // Exactly at the window the row is still kept: the comparison is strict.
    expect(isExpiredRow(OFFLINE_RETENTION_MS)).toBe(false);
  });

  it('expires a row once past the window', () => {
    expect(isExpiredRow(OFFLINE_RETENTION_MS + 1)).toBe(true);
  });

  // Regression: the sweep used to require online === false, so a row stranded
  // at online = true by a host that died before client_disconnected ran was
  // never collected and rendered as a motionless player to everyone, forever.
  it('expires a stranded row regardless of how it was left flagged', () => {
    expect(isExpiredRow(OFFLINE_RETENTION_MS * 10)).toBe(true);
  });
});
