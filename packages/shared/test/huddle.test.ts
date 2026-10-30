import {
  evaluateHuddleJoin,
  findJoinableHuddleId,
  HUDDLE_DEFAULT_NAME,
  HUDDLE_JOIN_DISTANCE,
  HUDDLE_LEAVE_DISTANCE,
  huddleLabel,
  keepsHuddleMembership,
  normalizeHuddleName,
  ZONE_NAME_MAX_LENGTH,
} from '@kaede/shared';
import { describe, expect, it } from 'vite-plus/test';

describe('ラベル合成', () => {
  it('立ち話はオープン 💬・クローズド 🤫 前置', () => {
    expect(huddleLabel('雑談', false)).toBe('💬 雑談');
    expect(huddleLabel('雑談', true)).toBe('🤫 雑談');
  });
});

describe('normalizeHuddleName', () => {
  it('正規化した名前を受理し、空は既定名になる(拒否ではない)', () => {
    expect(normalizeHuddleName('  雑談　部屋 ')).toEqual({ ok: true, name: '雑談 部屋' });
    expect(normalizeHuddleName('')).toEqual({ ok: true, name: HUDDLE_DEFAULT_NAME });
    expect(normalizeHuddleName('   ')).toEqual({ ok: true, name: HUDDLE_DEFAULT_NAME });
  });

  it('上限超え・禁止文字は拒否する', () => {
    expect(normalizeHuddleName('あ'.repeat(ZONE_NAME_MAX_LENGTH + 1))).toEqual({
      ok: false,
      reason: 'too-long',
    });
    expect(normalizeHuddleName('雑談\u0007')).toEqual({
      ok: false,
      reason: 'forbidden-characters',
    });
  });
});

describe('evaluateHuddleJoin', () => {
  const member = { x: 500, y: 600 };

  it('最寄りメンバーから参加距離内なら受理する', () => {
    expect(
      evaluateHuddleJoin({
        position: { x: 500 + HUDDLE_JOIN_DISTANCE, y: 600 },
        mapId: 0,
        huddleMapId: 0,
        memberPositions: [member],
      }),
    ).toEqual({ ok: true });
  });

  it('参加距離の外・別マップ・メンバー不在は拒否する', () => {
    expect(
      evaluateHuddleJoin({
        position: { x: 500 + HUDDLE_JOIN_DISTANCE + 1, y: 600 },
        mapId: 0,
        huddleMapId: 0,
        memberPositions: [member],
      }),
    ).toEqual({ ok: false, reason: 'too-far' });
    expect(
      evaluateHuddleJoin({
        position: member,
        mapId: 1,
        huddleMapId: 0,
        memberPositions: [member],
      }),
    ).toEqual({ ok: false, reason: 'wrong-map' });
    expect(
      evaluateHuddleJoin({ position: member, mapId: 0, huddleMapId: 0, memberPositions: [] }),
    ).toEqual({ ok: false, reason: 'too-far' });
  });

  it('距離はユークリッド(斜め方向も同じ半径)', () => {
    // Floored: the exact diagonal reconstructs the radius with float error above it.
    const diagonal = Math.floor(HUDDLE_JOIN_DISTANCE / Math.SQRT2);
    expect(
      evaluateHuddleJoin({
        position: { x: 500 + diagonal, y: 600 + diagonal },
        mapId: 0,
        huddleMapId: 0,
        memberPositions: [member],
      }).ok,
    ).toBe(true);
    expect(
      evaluateHuddleJoin({
        position: { x: 500 + diagonal + 2, y: 600 + diagonal + 2 },
        mapId: 0,
        huddleMapId: 0,
        memberPositions: [member],
      }).ok,
    ).toBe(false);
  });
});

describe('keepsHuddleMembership', () => {
  const other = { x: 500, y: 600 };

  it('離脱距離まで在籍、越えたら退出(参加距離とのギャップがヒステリシス)', () => {
    expect(
      keepsHuddleMembership({
        position: { x: 500 + HUDDLE_LEAVE_DISTANCE, y: 600 },
        mapId: 0,
        huddleMapId: 0,
        otherMemberPositions: [other],
      }),
    ).toBe(true);
    expect(
      keepsHuddleMembership({
        position: { x: 500 + HUDDLE_LEAVE_DISTANCE + 1, y: 600 },
        mapId: 0,
        huddleMapId: 0,
        otherMemberPositions: [other],
      }),
    ).toBe(false);
    expect(HUDDLE_LEAVE_DISTANCE).toBeGreaterThan(HUDDLE_JOIN_DISTANCE);
  });

  it('どれか1人の近くに居れば在籍(最寄りメンバー距離)', () => {
    expect(
      keepsHuddleMembership({
        position: { x: 500 + HUDDLE_LEAVE_DISTANCE + 100, y: 600 },
        mapId: 0,
        huddleMapId: 0,
        otherMemberPositions: [other, { x: 500 + HUDDLE_LEAVE_DISTANCE + 50, y: 600 }],
      }),
    ).toBe(true);
  });

  it('ソロの立ち話はアバターに追従(距離では退出しない)、マップ違いは退出', () => {
    expect(
      keepsHuddleMembership({
        position: { x: 9999, y: 600 },
        mapId: 0,
        huddleMapId: 0,
        otherMemberPositions: [],
      }),
    ).toBe(true);
    expect(
      keepsHuddleMembership({
        position: other,
        mapId: 1,
        huddleMapId: 0,
        otherMemberPositions: [],
      }),
    ).toBe(false);
  });
});

describe('findJoinableHuddleId', () => {
  const huddles = [
    { id: 7n, mapId: 0, memberPositions: [{ x: 500, y: 600 }] },
    { id: 8n, mapId: 0, memberPositions: [{ x: 560, y: 600 }] },
    { id: 9n, mapId: 1, memberPositions: [{ x: 500, y: 600 }] },
  ];

  it('参加できる最初(id 最小)の立ち話を返し、届かなければ undefined', () => {
    expect(findJoinableHuddleId({ x: 530, y: 600 }, 0, huddles)).toBe(7n);
    expect(findJoinableHuddleId({ x: 2000, y: 600 }, 0, huddles)).toBeUndefined();
  });

  it('別マップの立ち話は候補にならない', () => {
    expect(findJoinableHuddleId({ x: 500, y: 600 }, 2, huddles)).toBeUndefined();
  });
});
