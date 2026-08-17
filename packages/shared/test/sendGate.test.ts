import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAP,
  evaluateSendWindow,
  GROUND_TOP,
  isGroundContactEdge,
  isQuiescent,
  PLAYER_HALF_H,
  type PlayerInput,
  type PlayerState,
  SPAWN_X,
  stepPlayer,
} from '../src';

const NO_INPUT: PlayerInput = { left: false, right: false, up: false, down: false, jump: false };

/** 地面の上で静止している状態 (DEFAULT_MAP の唯一の solid の上)。 */
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

/** ワンウェイ足場の上で静止している状態 (platforms[0] の上)。 */
function onPlatform(): PlayerState {
  const p = DEFAULT_MAP.platforms[0];
  return {
    x: p.x + p.w / 2,
    y: p.y - PLAYER_HALF_H,
    vx: 0,
    vy: 0,
    facing: -1,
    onGround: true,
    rope: -1,
  };
}

describe('isQuiescent', () => {
  it('接地・速度ゼロ・ロープ非使用が静止', () => {
    expect(isQuiescent(grounded())).toBe(true);
    expect(isQuiescent(onPlatform())).toBe(true);
  });

  it('空中・移動中・ロープ上は静止ではない', () => {
    expect(isQuiescent({ ...grounded(), onGround: false })).toBe(false);
    expect(isQuiescent({ ...grounded(), vx: 240 })).toBe(false);
    expect(isQuiescent({ ...grounded(), vy: -840, onGround: false })).toBe(false);
    expect(isQuiescent({ ...grounded(), rope: 0, onGround: false })).toBe(false);
  });

  it('静止状態は空入力の不動点(プロトコル両側が依存する不変条件)', () => {
    // クライアントの送信ゲートは「飛ばした tick は全部 no-op」を、サーバーの
    // ギャップ受理は「リプレイしなくても同じ状態」を、この不変条件に頼る。
    // 重力は毎 tick かかるが、接地の衝突解決が同じ場所に押し戻す。
    for (const start of [grounded(), onPlatform()]) {
      let s = start;
      for (let i = 0; i < 10; i++) {
        s = stepPlayer(s, NO_INPUT, DEFAULT_MAP);
        expect(s).toEqual(start);
      }
    }
  });
});

describe('evaluateSendWindow (送信ゲート)', () => {
  it('入力なし・静止起点・全ack のときだけ skip', () => {
    expect(
      evaluateSendWindow({ anyInput: false, windowStartState: grounded(), fullyAcked: true }),
    ).toBe('skip');
  });

  it('入力があれば送る', () => {
    expect(
      evaluateSendWindow({ anyInput: true, windowStartState: grounded(), fullyAcked: true }),
    ).toBe('send');
  });

  it('起点が静止でなければ空入力でも送り続ける(ジャンプ後の落下・減速の同期)', () => {
    const falling: PlayerState = { ...grounded(), y: 400, vy: 300, onGround: false };
    expect(
      evaluateSendWindow({ anyInput: false, windowStartState: falling, fullyAcked: true }),
    ).toBe('send');
  });

  it('未ackのバッチが残っている間は黙らない(落ちた最終バッチをウォッチドッグが拾えるように)', () => {
    expect(
      evaluateSendWindow({ anyInput: false, windowStartState: grounded(), fullyAcked: false }),
    ).toBe('send');
  });

  it('ロープ上の静止は skip しない(仕様: ロープ非使用が条件)', () => {
    const onRope: PlayerState = { ...grounded(), rope: 0, onGround: false };
    expect(
      evaluateSendWindow({ anyInput: false, windowStartState: onRope, fullyAcked: true }),
    ).toBe('send');
  });
});

describe('isGroundContactEdge (接地エッジの即時フラッシュ判定)', () => {
  it('踏切(接地→空中)と着地(空中→接地)でフラッシュする', () => {
    expect(isGroundContactEdge(true, false)).toBe(true);
    expect(isGroundContactEdge(false, true)).toBe(true);
  });

  it('接地継続・滞空継続ではフラッシュしない(歩行や滞空で送信レートは増えない)', () => {
    expect(isGroundContactEdge(true, true)).toBe(false);
    expect(isGroundContactEdge(false, false)).toBe(false);
  });
});
