import {
  DEFAULT_MAP_ID,
  decidePortalCall,
  detectPortalIntent,
  evaluatePortalSend,
  evaluatePortalUse,
  isQuiescent,
  MAPS,
  mapFor,
  PLAYER_HALF_H,
  type PlayerInput,
  type PlayerState,
  PORTAL_PENDING_TIMEOUT_MS,
  portalIndexAt,
  stepPlayer,
} from '@kaede/shared';
import { describe, expect, it } from 'vitest';

const NO_INPUT: PlayerInput = { left: false, right: false, jump: false, up: false, down: false };
const UP: PlayerInput = { ...NO_INPUT, up: true };

const PLAZA = MAPS[0];
const PORTAL = PLAZA.portals[0];
const PORTAL_CENTER_X = PORTAL.rect.x + PORTAL.rect.w / 2;

/** Standing on the ground slab at `x` (the portal-eligible pose). */
function standingAt(x: number): PlayerState {
  return {
    x,
    y: PLAZA.collision.solids[0].y - PLAYER_HALF_H,
    vx: 0,
    vy: 0,
    facing: 1,
    onGround: true,
    rope: -1,
  };
}

describe('マップ定義の不変条件', () => {
  it('MAPS は id で引ける(MAPS[id].id === id)', () => {
    for (const [index, map] of MAPS.entries()) {
      expect(map.id).toBe(index);
    }
  });

  it('mapFor は未知の id をデフォルトマップに落とす', () => {
    expect(mapFor(1)).toBe(MAPS[1]);
    expect(mapFor(999)).toBe(MAPS[DEFAULT_MAP_ID]);
    expect(mapFor(-1)).toBe(MAPS[DEFAULT_MAP_ID]);
  });

  it('全ポータルの行き先は実在マップの静止点(無入力の不動点)に着地する', () => {
    for (const map of MAPS) {
      for (const portal of map.portals) {
        const destMap = MAPS[portal.target.mapId];
        expect(destMap).toBeDefined();
        if (!destMap) continue;
        const landed: PlayerState = {
          x: portal.target.x,
          y: portal.target.y,
          vx: 0,
          vy: 0,
          facing: 1,
          onGround: true,
          rope: -1,
        };
        // 着地状態が不動点でないと、テレポート直後に送信ゲートが閉じられない
        // (isQuiescent)し、無入力 tick で状態がずれて予測が乱れる。
        expect(stepPlayer(landed, NO_INPUT, destMap.collision)).toEqual(landed);
        expect(isQuiescent(landed)).toBe(true);
      }
    }
  });

  it('全ポータルの行き先は相手側ポータルの中(帰り道は up 一発)', () => {
    for (const map of MAPS) {
      for (const portal of map.portals) {
        const destMap = MAPS[portal.target.mapId];
        if (!destMap) continue;
        const landed = standingAt(0);
        landed.x = portal.target.x;
        landed.y = portal.target.y;
        expect(portalIndexAt(landed, destMap)).not.toBeUndefined();
      }
    }
  });

  it('ポータルのトリガー域はロープの掴み範囲と重ならない(up の意味が競合しない)', () => {
    for (const map of MAPS) {
      for (const portal of map.portals) {
        // トリガー域の全幅を歩きながら up しても、ロープ掴みが起きないこと。
        for (let x = portal.rect.x; x <= portal.rect.x + portal.rect.w; x += 4) {
          const stepped = stepPlayer(
            { ...standingAt(x), y: map.collision.solids[0].y - PLAYER_HALF_H },
            UP,
            map.collision,
          );
          expect(stepped.rope).toBe(-1);
        }
      }
    }
  });
});

describe('portalIndexAt', () => {
  it('ポータル内に立っているとその index を返す', () => {
    expect(portalIndexAt(standingAt(PORTAL_CENTER_X), PLAZA)).toBe(0);
  });

  it('トリガー域の外では undefined', () => {
    expect(portalIndexAt(standingAt(PORTAL_CENTER_X + 200), PLAZA)).toBeUndefined();
  });

  it('空中では undefined(up はジャンプ中に意味を持たない)', () => {
    const airborne = { ...standingAt(PORTAL_CENTER_X), onGround: false, vy: -100 };
    expect(portalIndexAt(airborne, PLAZA)).toBeUndefined();
  });

  it('ロープ上では undefined(up は登る)', () => {
    const climbing = { ...standingAt(PORTAL_CENTER_X), onGround: false, rope: 0 };
    expect(portalIndexAt(climbing, PLAZA)).toBeUndefined();
  });
});

describe('detectPortalIntent', () => {
  const state = standingAt(PORTAL_CENTER_X);

  it('up の押し始めのみ発火する(押しっぱなしでは再発火しない)', () => {
    expect(detectPortalIntent({ input: UP, prevInput: NO_INPUT, state, map: PLAZA })).toBe(0);
    expect(detectPortalIntent({ input: UP, prevInput: UP, state, map: PLAZA })).toBeUndefined();
    expect(
      detectPortalIntent({ input: NO_INPUT, prevInput: NO_INPUT, state, map: PLAZA }),
    ).toBeUndefined();
  });

  it('ポータル外の up では発火しない', () => {
    const away = standingAt(PORTAL_CENTER_X + 500);
    expect(detectPortalIntent({ input: UP, prevInput: NO_INPUT, state: away, map: PLAZA })).toBe(
      undefined,
    );
  });
});

describe('decidePortalCall', () => {
  const state = standingAt(PORTAL_CENTER_X);
  const intent = { input: UP, prevInput: NO_INPUT, state, map: PLAZA };

  it('呼び出しが飛んでいない間は意図をそのまま返す', () => {
    expect(decidePortalCall({ ...intent, nowMs: 1000, pendingSinceMs: undefined })).toBe(0);
  });

  it('呼び出しが飛んでいる間の再押下は抑止し、タイムアウト後に解禁する', () => {
    const sentAt = 1000;
    expect(decidePortalCall({ ...intent, nowMs: sentAt + 100, pendingSinceMs: sentAt })).toBe(
      undefined,
    );
    expect(
      decidePortalCall({
        ...intent,
        nowMs: sentAt + PORTAL_PENDING_TIMEOUT_MS,
        pendingSinceMs: sentAt,
      }),
    ).toBe(0);
  });
});

describe('evaluatePortalUse', () => {
  it('ポータル内の呼び出しを行き先つきで受理する', () => {
    const verdict = evaluatePortalUse({
      state: standingAt(PORTAL_CENTER_X),
      portalId: 0,
      map: PLAZA,
    });
    expect(verdict).toEqual({ ok: true, target: PORTAL.target });
  });

  it('存在しない portalId を拒否する', () => {
    const verdict = evaluatePortalUse({
      state: standingAt(PORTAL_CENTER_X),
      portalId: 99,
      map: PLAZA,
    });
    expect(verdict).toEqual({ ok: false, reason: 'no-such-portal' });
  });

  it('ポータル外からの呼び出しを拒否する(クライアント解決を鵜呑みにしない)', () => {
    const verdict = evaluatePortalUse({
      state: standingAt(PORTAL_CENTER_X + 300),
      portalId: 0,
      map: PLAZA,
    });
    expect(verdict).toEqual({ ok: false, reason: 'not-at-portal' });
  });
});

describe('evaluatePortalSend(レート制限)', () => {
  const SECOND = 1_000_000n;

  it('バースト分を使い切ると拒否され、実時間の経過で回復する', () => {
    let marker = 0n;
    const now = 1_000n * SECOND;
    // 初回はエポックのマーカー = ちょうどフルバースト(5回)。
    for (let i = 0; i < 5; i++) {
      const verdict = evaluatePortalSend({ allowanceMicros: marker, nowMicros: now });
      expect(verdict.ok).toBe(true);
      if (verdict.ok) marker = verdict.allowanceMicros;
    }
    expect(evaluatePortalSend({ allowanceMicros: marker, nowMicros: now })).toEqual({
      ok: false,
      reason: 'rate-limited',
    });
    // 1秒(= コスト1回分)進めば1回ぶん回復する。
    const later = now + SECOND;
    const verdict = evaluatePortalSend({ allowanceMicros: marker, nowMicros: later });
    expect(verdict.ok).toBe(true);
  });
});
