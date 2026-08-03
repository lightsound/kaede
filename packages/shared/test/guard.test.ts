import { describe, expect, it } from 'vitest';
import {
  evaluateInputBatch,
  HEARTBEAT_CHECK_INTERVAL_MS,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_MIN_AGE_MS,
  INPUT_BATCH_MAX_TICKS,
  INPUT_FLUSH_INTERVAL_MS,
  isExpiredRow,
  MAX_TICK_BANK,
  OFFLINE_RETENTION_MS,
  RESEND_TIMEOUT_MS,
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
    rowQuiescent: false,
    rowAgeMs: 0,
    rowOnline: true,
    allowanceMicros: 0n,
    nowMicros: micros(6),
    ...overrides,
  });
}

describe('プロトコル定数の整合(アイドル抑制)', () => {
  it('1フラッシュ分の tick は1回の呼び出しに収まる(移動中 2〜3 calls/秒の前提)', () => {
    const ticksPerFlush = (TICK_RATE * INPUT_FLUSH_INTERVAL_MS) / 1000;
    expect(INPUT_BATCH_MAX_TICKS).toBeGreaterThanOrEqual(ticksPerFlush);
    // 移動中の呼び出しレートが目標帯 (2〜3 calls/秒) に入っていること。
    expect(1000 / INPUT_FLUSH_INTERVAL_MS).toBeGreaterThanOrEqual(2);
    expect(1000 / INPUT_FLUSH_INTERVAL_MS).toBeLessThanOrEqual(3);
  });

  it('再送ウォッチドッグはフラッシュ間隔より十分長い(通常の ack を再送と誤認しない)', () => {
    expect(RESEND_TIMEOUT_MS).toBeGreaterThanOrEqual(INPUT_FLUSH_INTERVAL_MS * 2);
  });

  it('ハートビートは保持窓に対して2回落としても掃除されない間隔', () => {
    // 実効の最悪送信間隔は「間隔 + 判定粒度」。その3倍(2回連続で落ちても
    // 3本目が届く時刻)が保持窓より 30 秒以上手前なら、配送遅延・判定
    // コールバックのジッタがモデル外で乗っても生きた行は掃除されない。
    const worstSendIntervalMs = HEARTBEAT_INTERVAL_MS + HEARTBEAT_CHECK_INTERVAL_MS;
    expect(worstSendIntervalMs * 3).toBeLessThanOrEqual(OFFLINE_RETENTION_MS - 30_000);
    expect(HEARTBEAT_MIN_AGE_MS).toBeLessThan(HEARTBEAT_INTERVAL_MS);
  });
});

describe('evaluateInputBatch', () => {
  it('空バッチはハートビート: 行が十分古ければ updatedAt の更新を指示する', () => {
    expect(batch({ batchLength: 0, rowAgeMs: HEARTBEAT_MIN_AGE_MS })).toEqual({
      kind: 'heartbeat',
      refresh: true,
    });
  });

  it('新しすぎる行へのハートビートは受理するが書き込まない(空バッチ乱打の egress 抑止)', () => {
    expect(batch({ batchLength: 0, rowAgeMs: HEARTBEAT_MIN_AGE_MS - 1 })).toEqual({
      kind: 'heartbeat',
      refresh: false,
    });
  });

  it('オフライン行へのハートビートは行齢に関係なく書き込む(再接続の生存宣言)', () => {
    // 休止からの復帰は join を通らないため、これがオフライン行を可視に戻す
    // 唯一の経路(入力ゼロのままでは送信ゲートがバッチを流さない)。
    expect(batch({ batchLength: 0, rowAgeMs: 0, rowOnline: false })).toEqual({
      kind: 'heartbeat',
      refresh: true,
    });
  });

  it('ハートビートは tick の整合を要求しない(静止中は tick が進まないのが正常)', () => {
    const v = batch({
      batchLength: 0,
      startTick: 9999,
      rowTick: 6,
      rowAgeMs: HEARTBEAT_MIN_AGE_MS,
    });
    expect(v.kind).toBe('heartbeat');
  });

  it('rejects a batch above INPUT_BATCH_MAX_TICKS', () => {
    expect(batch({ batchLength: INPUT_BATCH_MAX_TICKS + 1 })).toEqual({
      kind: 'rejected',
      reason: 'oversized-batch',
    });
  });

  it('rejects a duplicate batch (startTick behind the row)', () => {
    expect(batch({ startTick: 5, rowTick: 6 })).toEqual({ kind: 'rejected', reason: 'stale-tick' });
  });

  it('静止していない行へのギャップ付きバッチは拒否する(飛ばした tick が no-op と証明できない)', () => {
    expect(batch({ startTick: 7, rowTick: 6, rowQuiescent: false })).toEqual({
      kind: 'rejected',
      reason: 'gap-ahead-of-row',
    });
  });

  it('静止した行へのギャップ付きバッチは受理し、支払いはバッチ長ぶんだけ', () => {
    // 送信ゲートが 1000 tick 飛ばした後の再開バッチ。ギャップは空入力の
    // 不動点上なので、リプレイなしで tick だけ進めてよい。
    const now = micros(1006);
    const v = batch({
      startTick: 1000,
      rowTick: 0,
      rowQuiescent: true,
      batchLength: 6,
      allowanceMicros: micros(1000),
      nowMicros: now,
    });
    if (v.kind !== 'apply') throw new Error('expected apply');
    // マーカー前進はギャップ(1000 tick)ではなくバッチ長(6 tick)ぶん。
    expect(v.allowanceMicros).toBe(micros(1000) + BigInt(Math.floor(6 * MICROS_PER_TICK)));
  });

  it('accepts the normal cadence: batch duration matches elapsed wall clock', () => {
    const v = batch({ batchLength: 6, allowanceMicros: 0n, nowMicros: micros(6) });
    expect(v.kind).toBe('apply');
  });

  it('advances the marker by exactly the accepted batch duration', () => {
    const v = batch({ batchLength: 6, allowanceMicros: micros(100), nowMicros: micros(107) });
    if (v.kind !== 'apply') throw new Error('expected apply');
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
    expect(v.kind).toBe('apply');
  });

  it('rejects once the slack is spent, until real time catches up', () => {
    const now = micros(1000);
    // Marker already TICK_ALLOWANCE_SLACK ticks in the future: nothing left.
    const ahead = now + BigInt(Math.ceil(TICK_ALLOWANCE_SLACK * MICROS_PER_TICK));
    expect(batch({ batchLength: 1, allowanceMicros: ahead, nowMicros: now })).toEqual({
      kind: 'rejected',
      reason: 'rate-limited',
    });
    // One tick of wall clock later, one tick of input is allowed again.
    const later = now + BigInt(Math.ceil((TICK_ALLOWANCE_SLACK + 1) * MICROS_PER_TICK));
    expect(batch({ batchLength: 1, allowanceMicros: ahead, nowMicros: later }).kind).toBe('apply');
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
        rowQuiescent: false,
        rowAgeMs: 0,
        rowOnline: true,
        allowanceMicros: marker,
        nowMicros: now,
      });
      if (v.kind !== 'apply') break;
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
        rowQuiescent: false,
        rowAgeMs: 0,
        rowOnline: true,
        allowanceMicros: marker,
        nowMicros: micros(flush * 6),
      });
      if (v.kind !== 'apply') {
        throw new Error(`flush ${flush} not applied: ${v.kind === 'rejected' ? v.reason : v.kind}`);
      }
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
