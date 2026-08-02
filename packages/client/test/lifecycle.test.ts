import { describe, expect, it } from 'vitest';
import {
  initialLifecycle,
  type LifecycleEffect,
  type LifecycleEvent,
  type LifecycleState,
  RETRY_INITIAL_MS,
  RETRY_MAX_MS,
  transition,
} from '../src/net.package/lifecycle';

/** Applies events in order, returning the final state and each step's effects. */
function run(events: LifecycleEvent[], from: LifecycleState = initialLifecycle()) {
  let state = from;
  const steps: LifecycleEffect[][] = [];
  for (const event of events) {
    const t = transition(state, event);
    state = t.state;
    steps.push(t.effects);
  }
  return { state, steps, last: steps[steps.length - 1] ?? [] };
}

const kinds = (effects: LifecycleEffect[]) => effects.map((e) => e.kind);

describe('接続確立まで', () => {
  it('start は世代1の connect を開始し connecting を報告する', () => {
    const { state, last } = run([{ kind: 'start' }]);
    expect(last).toEqual([
      { kind: 'status', status: 'connecting' },
      { kind: 'connect', generation: 1, consecutiveFailures: 0 },
    ]);
    expect(state.attemptInFlight).toBe(true);
    expect(state.generation).toBe(1);
  });

  it('connect-ok はセッションを配線し、失敗カウントと backoff を初期化する', () => {
    const before = run([
      { kind: 'start' },
      { kind: 'connect-failed' },
      { kind: 'retry-due' },
      { kind: 'connect-ok' },
    ]);
    expect(before.last).toEqual([
      { kind: 'status', status: 'connected' },
      { kind: 'wire-session', generation: 2 },
    ]);
    expect(before.state.sessionLive).toBe(true);
    expect(before.state.everConnected).toBe(true);
    expect(before.state.consecutiveFailures).toBe(0);
    expect(before.state.retryDelayMs).toBe(RETRY_INITIAL_MS);
  });
});

describe('失敗と再試行', () => {
  it('失敗ごとに backoff が1回だけ倍加する(reject と close の二重報告に耐える)', () => {
    // connection.ts は失敗した接続で connect-failed と socket-closed の両方を
    // 報告する。armed チェックがなければ backoff は1ラウンドで2回倍加した。
    const { state, steps } = run([
      { kind: 'start' },
      { kind: 'connect-failed' },
      { kind: 'socket-closed', generation: 1 },
    ]);
    expect(steps[1]).toEqual([
      { kind: 'status', status: 'connecting' },
      { kind: 'arm-retry', delayMs: RETRY_INITIAL_MS },
    ]);
    // 同じ失敗のソケットクローズは drop-session だけで、再武装しない。
    expect(kinds(steps[2])).toEqual(['drop-session']);
    expect(state.retryDelayMs).toBe(RETRY_INITIAL_MS * 2);
  });

  it('失敗が続くと backoff は倍々で伸び、上限で頭打ちになる', () => {
    let state = initialLifecycle();
    const delays: number[] = [];
    for (let i = 0; i < 8; i++) {
      const started = transition(state, { kind: i === 0 ? 'start' : 'retry-due' });
      const failed = transition(started.state, { kind: 'connect-failed' });
      state = failed.state;
      const retry = failed.effects.find(
        (e): e is Extract<LifecycleEffect, { kind: 'arm-retry' }> => e.kind === 'arm-retry',
      );
      expect(retry).toBeDefined();
      if (retry) delays.push(retry.delayMs);
    }
    expect(delays[0]).toBe(RETRY_INITIAL_MS);
    expect(delays[1]).toBe(RETRY_INITIAL_MS * 2);
    expect(delays[delays.length - 1]).toBe(RETRY_MAX_MS);
    expect(state.consecutiveFailures).toBe(8);
  });

  it('retry-due は次の connect を開始し、失敗カウントを引き継ぐ', () => {
    const { last } = run([{ kind: 'start' }, { kind: 'connect-failed' }, { kind: 'retry-due' }]);
    expect(last).toEqual([
      { kind: 'status', status: 'connecting' },
      { kind: 'connect', generation: 2, consecutiveFailures: 1 },
    ]);
  });

  it('確立済みセッションの切断は drop-session と reconnecting での再武装になる', () => {
    const { last } = run([
      { kind: 'start' },
      { kind: 'connect-ok' },
      { kind: 'socket-closed', generation: 1 },
    ]);
    expect(last).toEqual([
      { kind: 'drop-session' },
      { kind: 'status', status: 'reconnecting' },
      { kind: 'arm-retry', delayMs: RETRY_INITIAL_MS },
    ]);
  });

  it('古い世代のソケットクローズは何もしない', () => {
    // 休止が LIVE セッションを切ると世代が進む。閉じ終わりの報告は stale。
    const { last, state } = run([
      { kind: 'start' },
      { kind: 'connect-ok' },
      { kind: 'idle-timeout' },
      { kind: 'socket-closed', generation: 1 },
    ]);
    expect(last).toEqual([]);
    expect(state.generation).toBe(2);
  });
});

describe('アイドル休止と再開', () => {
  it('LIVE セッションの休止は再試行を止め、世代を進めてから切る', () => {
    const armed = run([
      { kind: 'start' },
      { kind: 'connect-ok' },
      { kind: 'socket-closed', generation: 1 }, // 再試行が武装した状態で
      { kind: 'idle-timeout' },
    ]);
    // 実際は LIVE か再試行中のどちらかだが、両方の後始末を1ステップで見る:
    // cancel-retry → status idle → drop-session → disconnect の順。
    expect(kinds(armed.steps[3])).toEqual(['cancel-retry', 'status', 'drop-session', 'disconnect']);
    expect(armed.state.suspended).toBe(true);
    expect(armed.state.retryArmed).toBe(false);
  });

  it('LIVE セッションを切る休止は世代を進める(pending な connect は進めない)', () => {
    const live = run([{ kind: 'start' }, { kind: 'connect-ok' }, { kind: 'idle-timeout' }]);
    expect(live.state.generation).toBe(2);

    // pending(接続確立前)の休止は世代を保つ: 復帰時にその connect を採用できる。
    const pending = run([{ kind: 'start' }, { kind: 'idle-timeout' }]);
    expect(pending.state.generation).toBe(1);
    expect(kinds(pending.last)).toEqual(['status', 'drop-session', 'disconnect']);
  });

  it('休止中に届いた connect-ok は破棄される(誰も頼んでいないセッションを開かない)', () => {
    const { last, state } = run([
      { kind: 'start' },
      { kind: 'idle-timeout' },
      { kind: 'connect-ok' },
    ]);
    expect(last).toEqual([{ kind: 'discard-attempt' }]);
    expect(state.sessionLive).toBe(false);
  });

  it('休止中の現行世代クローズは後始末だけで再武装しない', () => {
    const { last } = run([
      { kind: 'start' },
      { kind: 'idle-timeout' },
      { kind: 'socket-closed', generation: 1 },
    ]);
    expect(kinds(last)).toEqual(['drop-session']);
  });

  it('休止中の connect-failed は再武装しない(入力だけが再開する)', () => {
    const { last, state } = run([
      { kind: 'start' },
      { kind: 'idle-timeout' },
      { kind: 'connect-failed' },
    ]);
    expect(last).toEqual([]);
    expect(state.retryArmed).toBe(false);
  });

  it('resume は backoff を初期化し、新しい connect を開始する', () => {
    const { last, state } = run([
      { kind: 'start' },
      { kind: 'connect-ok' },
      { kind: 'idle-timeout' },
      { kind: 'resume' },
    ]);
    expect(last).toEqual([
      { kind: 'status', status: 'reconnecting' },
      { kind: 'status', status: 'reconnecting' },
      { kind: 'connect', generation: 3, consecutiveFailures: 0 },
    ]);
    expect(state.suspended).toBe(false);
    expect(state.retryDelayMs).toBe(RETRY_INITIAL_MS);
  });

  it('pending な connect の休止→復帰は status 報告だけで二重 connect を始めない', () => {
    // attempt は single-flight: 復帰はバナーを直すだけで、pending の connect が
    // そのまま帰還路になる(settle 時に connect-ok が生きた状態で処理される)。
    const { last, state } = run([{ kind: 'start' }, { kind: 'idle-timeout' }, { kind: 'resume' }]);
    expect(last).toEqual([{ kind: 'status', status: 'connecting' }]);
    expect(state.attemptInFlight).toBe(true);

    const settled = transition(state, { kind: 'connect-ok' });
    expect(kinds(settled.effects)).toEqual(['status', 'wire-session']);
  });

  it('休止していなければ resume は何もしない', () => {
    const { last } = run([{ kind: 'start' }, { kind: 'connect-ok' }, { kind: 'resume' }]);
    expect(last).toEqual([]);
  });
});

describe('dispose', () => {
  it('武装済みタイマーを解除し、現行接続を閉じ、以後のイベントを無効化する', () => {
    const { steps, state } = run([
      { kind: 'start' },
      { kind: 'connect-failed' },
      { kind: 'dispose' },
      { kind: 'retry-due' },
      { kind: 'socket-closed', generation: 1 },
      { kind: 'resume' },
      { kind: 'idle-timeout' },
    ]);
    expect(kinds(steps[2])).toEqual(['cancel-retry', 'disconnect']);
    for (const effects of steps.slice(3)) expect(effects).toEqual([]);
    expect(state.disposed).toBe(true);
  });

  it('dispose 後に届いた connect-ok は破棄される', () => {
    const { last } = run([{ kind: 'start' }, { kind: 'dispose' }, { kind: 'connect-ok' }]);
    expect(last).toEqual([{ kind: 'discard-attempt' }]);
  });
});

describe('純粋性', () => {
  it('transition は入力の状態を変更しない', () => {
    const state = initialLifecycle();
    const frozen = { ...state };
    transition(state, { kind: 'start' });
    expect(state).toEqual(frozen);
  });
});
