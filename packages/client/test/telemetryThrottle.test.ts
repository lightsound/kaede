import { describe, expect, it } from 'vitest';
import {
  createRateGate,
  EXCEPTION_THROTTLE_MS,
  exceptionFingerprint,
} from '../src/telemetry.package/throttle';

const exceptionProps = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  $exception_list: [
    {
      type: 'TypeError',
      value: "Cannot read properties of undefined (reading 'x')",
      stacktrace: {
        frames: [{ filename: 'app.js', function: 'tick', lineno: 42 }],
      },
    },
  ],
  ...over,
});

describe('exceptionFingerprint', () => {
  it('型・メッセージ・先頭フレームで同一性を決める', () => {
    const a = exceptionFingerprint(exceptionProps());
    const b = exceptionFingerprint(exceptionProps());
    expect(a).toBe(b);
    expect(a).toContain('TypeError');
    expect(a).toContain('tick');
  });

  it('場所が違えば別の指紋になる', () => {
    const other = exceptionFingerprint({
      $exception_list: [
        {
          type: 'TypeError',
          value: "Cannot read properties of undefined (reading 'x')",
          stacktrace: { frames: [{ filename: 'app.js', function: 'render', lineno: 7 }] },
        },
      ],
    });
    expect(other).not.toBe(exceptionFingerprint(exceptionProps()));
  });

  it('形が読めない例外は固定キーに落ちる(素通りさせない)', () => {
    expect(exceptionFingerprint(undefined)).toBe('unknown');
    expect(exceptionFingerprint({})).toBe('unknown');
    expect(exceptionFingerprint({ $exception_list: [] })).toBe('unknown');
    // リスト要素の形が壊れていても文字列キーには畳める。
    expect(exceptionFingerprint({ $exception_list: [null] })).toBe('||||');
  });
});

describe('createRateGate', () => {
  it('同一キーはウィンドウ内で1回だけ通す', () => {
    const gate = createRateGate();
    expect(gate('k', 0)).toBe(true);
    expect(gate('k', 1)).toBe(false);
    expect(gate('k', EXCEPTION_THROTTLE_MS - 1)).toBe(false);
    expect(gate('k', EXCEPTION_THROTTLE_MS)).toBe(true);
  });

  it('毎フレーム発火(60fps 相当)でも毎分1回に落ちる', () => {
    const gate = createRateGate();
    let sent = 0;
    for (let frame = 0; frame < 3600; frame++) {
      if (gate('ticker-bug', frame * 16.7)) sent += 1;
    }
    // 3,600 発火(約 60 秒)が 0 秒・30 秒・60 秒時点の 3 回に落ちる。
    expect(sent).toBe(3);
  });

  it('別キーは互いに影響しない', () => {
    const gate = createRateGate();
    expect(gate('a', 0)).toBe(true);
    expect(gate('b', 1)).toBe(true);
  });

  it('記憶は上限で最も古いキーから捨てられ、捨てられたキーは再び通る', () => {
    const gate = createRateGate(1000, 2);
    expect(gate('a', 0)).toBe(true);
    expect(gate('b', 1)).toBe(true);
    expect(gate('c', 2)).toBe(true); // a が捨てられる
    expect(gate('a', 3)).toBe(true); // 記憶喪失により1回通る(送信は止めない)
    expect(gate('c', 4)).toBe(false); // c は覚えている
  });
});
