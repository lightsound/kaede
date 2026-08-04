import {
  DEFAULT_MAP,
  GROUND_TOP,
  INPUT_BATCH_MAX_TICKS,
  INPUT_FLUSH_INTERVAL_MS,
  PLAYER_HALF_H,
  type PlayerInput,
  type PlayerState,
  PREDICTION_HISTORY_MAX_TICKS,
  packInput,
  RESEND_TIMEOUT_MS,
  SPAWN_X,
  stepPlayer,
} from '@kaede/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { createPrediction, type PredictionDeps } from '../src/net.package/prediction';

const NO_INPUT: PlayerInput = { left: false, right: false, jump: false, up: false, down: false };

/** The authoritative spawn state the prediction loop starts from (mid-air). */
function spawn(): PlayerState {
  return { x: SPAWN_X, y: 200, vx: 0, vy: 0, facing: 1, onGround: false, rope: -1 };
}

/** 地面の上で静止(送信ゲートが閉じられる状態)。 */
function grounded(): PlayerState {
  return {
    x: SPAWN_X,
    y: GROUND_TOP - PLAYER_HALF_H,
    vx: 0,
    vy: 0,
    facing: 1,
    onGround: true,
    rope: -1,
  };
}

interface SentBatch {
  startTick: number;
  packed: number[];
}

interface Reset {
  state: PlayerState;
  tick: number;
}

/** Spy deps that record every sendBatch / resetLocal call into plain arrays. */
function spyDeps(): {
  deps: PredictionDeps;
  sent: SentBatch[];
  resets: Reset[];
} {
  const sent: SentBatch[] = [];
  const resets: Reset[] = [];
  const deps: PredictionDeps = {
    sendBatch(startTick, packed) {
      sent.push({ startTick, packed: Array.from(packed) });
    },
    resetLocal(state, tick) {
      resets.push({ state, tick });
    },
  };
  return { deps, sent, resets };
}

/**
 * Drives the prediction loop exactly like GameApp: thread the same input
 * through the real shared physics to produce each authoritative-shaped state,
 * record it, and feed it to onTick with the packed input and an explicit clock.
 *
 * Returns the predicted state per tick (states[t]) plus the packed input that
 * produced it (packedAt[t]); states[startTick] is `start`.
 */
function driver(start: PlayerState, startTick: number) {
  const states = new Map<number, PlayerState>([[startTick, start]]);
  const packedAt = new Map<number, number>();
  let prev = start;
  let tick = startTick;

  return {
    states,
    packedAt,
    /** Step one tick with `input` at virtual time `nowMs`, feeding the loop. */
    step(loop: ReturnType<typeof createPrediction>, input: PlayerInput, nowMs: number) {
      tick += 1;
      const next = stepPlayer(prev, input, DEFAULT_MAP);
      states.set(tick, next);
      packedAt.set(tick, packInput(input));
      loop.onTick(next, tick, packInput(input), nowMs);
      prev = next;
      return tick;
    },
    get tick() {
      return tick;
    },
    state(t: number): PlayerState {
      const s = states.get(t);
      if (!s) throw new Error(`no recorded state for tick ${t}`);
      return s;
    },
  };
}

describe('createPrediction', () => {
  let deps: PredictionDeps;
  let sent: SentBatch[];
  let resets: Reset[];

  beforeEach(() => {
    ({ deps, sent, resets } = spyDeps());
  });

  describe('flush cadence + chunking', () => {
    it('sends one contiguous batch per flush window', () => {
      const loop = createPrediction(deps, 0, spawn(), 0);
      const drv = driver(spawn(), 0);

      const ticksPerWindow = 6;
      const windows = 3;
      for (let w = 0; w < windows; w++) {
        for (let i = 1; i <= ticksPerWindow; i++) {
          // The last tick of each window crosses the flush threshold, so the
          // whole window's worth of inputs is sent in one batch.
          const nowMs = i === ticksPerWindow ? (w + 1) * INPUT_FLUSH_INTERVAL_MS : 0;
          drv.step(loop, NO_INPUT, nowMs);
        }
      }

      expect(sent).toHaveLength(windows);
      // Contiguous batches: startTick is the tick before the window's first input.
      expect(sent.map((b) => b.startTick)).toEqual([0, 6, 12]);
      for (const batch of sent) expect(batch.packed).toHaveLength(ticksPerWindow);
    });

    it('splits a large backlog into chunks of <= INPUT_BATCH_MAX_TICKS', () => {
      const loop = createPrediction(deps, 0, spawn(), 0);
      const drv = driver(spawn(), 0);

      const pending = INPUT_BATCH_MAX_TICKS + 10;
      for (let i = 1; i <= pending; i++) {
        // Keep nowMs below the threshold until the final tick so the entire
        // backlog flushes in a single flush() call.
        const nowMs = i === pending ? INPUT_FLUSH_INTERVAL_MS : 0;
        drv.step(loop, NO_INPUT, nowMs);
      }

      expect(sent).toHaveLength(2);
      expect(sent[0].startTick).toBe(0);
      expect(sent[0].packed).toHaveLength(INPUT_BATCH_MAX_TICKS);
      expect(sent[1].startTick).toBe(INPUT_BATCH_MAX_TICKS);
      expect(sent[1].packed).toHaveLength(pending - INPUT_BATCH_MAX_TICKS);
      for (const batch of sent)
        expect(batch.packed.length).toBeLessThanOrEqual(INPUT_BATCH_MAX_TICKS);
    });
  });

  it('does not reset on an honest ack matching the predicted state', () => {
    const loop = createPrediction(deps, 0, spawn(), 0);
    const drv = driver(spawn(), 0);

    // Feed a few ticks with varied input so prediction has real content.
    const inputs: PlayerInput[] = [
      { ...NO_INPUT, right: true },
      { ...NO_INPUT, right: true, jump: true },
      { ...NO_INPUT, right: true },
      NO_INPUT,
    ];
    inputs.forEach((input, i) => {
      drv.step(loop, input, (i + 1) * INPUT_FLUSH_INTERVAL_MS);
    });

    const ackTick = 2;
    // Server replayed the same inputs deterministically: ack the exact predicted state.
    loop.onAck(drv.state(ackTick), ackTick, 1000);

    expect(resets).toHaveLength(0);
  });

  it('reconciles a divergent ack by replaying un-acked inputs', () => {
    const loop = createPrediction(deps, 0, spawn(), 0);
    const drv = driver(spawn(), 0);

    const inputs: PlayerInput[] = [
      { ...NO_INPUT, right: true },
      { ...NO_INPUT, right: true },
      { ...NO_INPUT, right: true, jump: true },
      { ...NO_INPUT, right: true },
      { ...NO_INPUT, left: true },
    ];
    inputs.forEach((input, i) => {
      drv.step(loop, input, (i + 1) * INPUT_FLUSH_INTERVAL_MS);
    });

    const ackTick = 2;
    const currentTick = drv.tick;
    // Authoritative state differs from our prediction at the ack tick.
    const authoritative: PlayerState = { ...drv.state(ackTick), x: drv.state(ackTick).x + 7 };

    // Expected: fold the recorded un-acked inputs forward from the authoritative
    // state, ackTick+1 .. currentTick, with the real shared physics.
    let expected = authoritative;
    for (let t = ackTick + 1; t <= currentTick; t++) {
      expected = stepPlayer(expected, inputs[t - 1], DEFAULT_MAP);
    }

    loop.onAck(authoritative, ackTick, 1000);

    expect(resets).toHaveLength(1);
    expect(resets[0].tick).toBe(currentTick);
    expect(resets[0].state).toEqual(expected);
  });

  it('re-sends from the acked tick after the resend watchdog fires', () => {
    const loop = createPrediction(deps, 0, spawn(), 0);
    const drv = driver(spawn(), 0);

    // Window 1: ticks 1..3 flush as one batch at t=INPUT_FLUSH_INTERVAL_MS. Never acked.
    drv.step(loop, NO_INPUT, 0);
    drv.step(loop, NO_INPUT, 0);
    drv.step(loop, NO_INPUT, INPUT_FLUSH_INTERVAL_MS);
    expect(sent).toHaveLength(1);
    expect(sent[0].startTick).toBe(0);

    // Advance the virtual clock past the resend timeout (relative to creation,
    // when lastAckAdvanceAt was seeded). The next flush must rewind to ackedTick.
    const watchdogNow = RESEND_TIMEOUT_MS + INPUT_FLUSH_INTERVAL_MS;
    drv.step(loop, NO_INPUT, watchdogNow);

    expect(sent).toHaveLength(2);
    // Re-send starts from ackedTick (0), re-covering the un-acked ticks 1..4.
    expect(sent[1].startTick).toBe(0);
    expect(sent[1].packed.length).toBe(drv.tick);
  });

  describe('送信ゲート(アイドル抑制): 静止中は送信が止まる', () => {
    /** 1フラッシュウィンドウぶん(6 tick)進め、最後の tick でフラッシュさせる。 */
    function window(
      loop: ReturnType<typeof createPrediction>,
      drv: ReturnType<typeof driver>,
      input: PlayerInput,
      w: number,
    ): void {
      for (let i = 1; i <= 6; i++) {
        drv.step(loop, input, i === 6 ? w * INPUT_FLUSH_INTERVAL_MS : 0);
      }
    }

    it('静止起点・入力なし・全ackなら最初のウィンドウから何も送らない', () => {
      const loop = createPrediction(deps, 0, grounded(), 0);
      const drv = driver(grounded(), 0);
      for (let w = 1; w <= 3; w++) window(loop, drv, NO_INPUT, w);
      expect(sent).toHaveLength(0);
    });

    it('空中では入力がなくても空入力を送り続け、静止到達+ackで止まる', () => {
      // spawn() は空中: 落下→着地(~38 tick)までは、キーを離していても
      // サーバーに物理を進めさせるために空バッチが流れ続けなければならない。
      const loop = createPrediction(deps, 0, spawn(), 0);
      const drv = driver(spawn(), 0);
      for (let w = 1; w <= 10; w++) {
        window(loop, drv, NO_INPUT, w);
        // サーバー役: 決定論リプレイの結果を ack(常に予測と一致)。
        loop.onAck(drv.state(drv.tick), drv.tick, w * INPUT_FLUSH_INTERVAL_MS);
      }
      // 落下中のウィンドウはすべて送られた(少なくとも着地までの6本)。
      expect(sent.length).toBeGreaterThanOrEqual(6);
      expect(drv.state(drv.tick).onGround).toBe(true);

      // 静止到達+ack後: それ以降のウィンドウは1本も送られない。
      const settled = sent.length;
      for (let w = 11; w <= 14; w++) window(loop, drv, NO_INPUT, w);
      expect(sent).toHaveLength(settled);
    });

    it('抑制中に飛ばした tick は、再開バッチの startTick のギャップとして現れる', () => {
      const loop = createPrediction(deps, 0, grounded(), 0);
      const drv = driver(grounded(), 0);
      // ウィンドウ2本(tick 1..12)は静止スキップ: サーバーの行 tick は 0 のまま。
      for (let w = 1; w <= 2; w++) window(loop, drv, NO_INPUT, w);
      expect(sent).toHaveLength(0);

      // 入力再開: ウィンドウ3(tick 13..18)が入力を含むので送られる。startTick は
      // 仮想 ack 位置(12) — サーバーの行 tick(0)よりも先で、サーバー側は
      // 行が静止しているのでこのギャップを受理する(evaluateInputBatch)。
      window(loop, drv, { ...NO_INPUT, right: true }, 3);
      expect(sent).toHaveLength(1);
      expect(sent[0].startTick).toBe(12);
      expect(sent[0].packed).toHaveLength(6);
    });

    it('ハートビートによる行更新(tick が進まない ack)は無視する', () => {
      const loop = createPrediction(deps, 0, grounded(), 0);
      const drv = driver(grounded(), 0);
      for (let w = 1; w <= 2; w++) window(loop, drv, NO_INPUT, w);

      // サーバーのハートビートは updatedAt だけ進めて tick 0 のまま行を再送する。
      // 仮想 ack(12) より古い ack として無視され、リセットも再送も起きない。
      loop.onAck(grounded(), 0, 2 * INPUT_FLUSH_INTERVAL_MS);
      expect(resets).toHaveLength(0);
      window(loop, drv, NO_INPUT, 3);
      expect(sent).toHaveLength(0);
    });

    it('未ackのバッチが残っている間は静止しても黙らない(ackが揃ってから止まる)', () => {
      const loop = createPrediction(deps, 0, grounded(), 0);
      const drv = driver(grounded(), 0);
      // ウィンドウ1: 最初の tick だけ右入力 → 送信。ack はまだ返さない。
      drv.step(loop, { ...NO_INPUT, right: true }, 0);
      for (let i = 2; i <= 6; i++) {
        drv.step(loop, NO_INPUT, i === 6 ? INPUT_FLUSH_INTERVAL_MS : 0);
      }
      expect(sent).toHaveLength(1);

      // ウィンドウ2: 入力なし・すでに静止だが、未ackなので送り続ける
      // (このバッチが落ちていた場合の再送経路を殺さないため)。
      window(loop, drv, NO_INPUT, 2);
      expect(sent).toHaveLength(2);

      // ackが揃うと次のウィンドウから止まる。
      loop.onAck(drv.state(drv.tick), drv.tick, 2 * INPUT_FLUSH_INTERVAL_MS);
      window(loop, drv, NO_INPUT, 3);
      expect(sent).toHaveLength(2);
    });
  });

  it('hard-resets to the authoritative state when the ack predates kept history', () => {
    const loop = createPrediction(deps, 0, spawn(), 0);
    const drv = driver(spawn(), 0);

    // Feed more ticks than the history cap so the oldest entries are pruned.
    const total = PREDICTION_HISTORY_MAX_TICKS + 50;
    for (let i = 1; i <= total; i++) {
      const nowMs = i % 6 === 0 ? i * INPUT_FLUSH_INTERVAL_MS : 0;
      drv.step(loop, NO_INPUT, nowMs);
    }

    // Ack a tick far below the kept window: its successor input (ackTick+1) is no
    // longer in history, so the loop cannot replay forward and must hard reset.
    const ackTick = 5;
    expect(ackTick + 1).toBeLessThan(total - PREDICTION_HISTORY_MAX_TICKS);
    const authoritative = drv.state(ackTick);

    loop.onAck(authoritative, ackTick, total * INPUT_FLUSH_INTERVAL_MS);

    expect(resets).toHaveLength(1);
    expect(resets[0].tick).toBe(ackTick);
    expect(resets[0].state).toEqual(authoritative);
  });
});
