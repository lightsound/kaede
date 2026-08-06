import {
  clampZoneRect,
  evaluateHuddleJoin,
  evaluateZoneSpec,
  findJoinableHuddleId,
  groupTagLabel,
  HUDDLE_DEFAULT_NAME,
  HUDDLE_JOIN_DISTANCE,
  HUDDLE_LEAVE_DISTANCE,
  huddleLabel,
  isMeetingIdLike,
  isRecordingIdLike,
  isRecordingStatus,
  recordingStatusFromProvider,
  RECORDING_STATUS_RECORDING,
  RECORDING_STATUS_UPLOADED,
  keepsHuddleMembership,
  normalizeHuddleName,
  resolveZoneOccupancy,
  sortedHuddleRows,
  sortedZoneRows,
  ZONE_EXIT_MARGIN,
  ZONE_MAX_SIZE,
  ZONE_MIN_SIZE,
  ZONE_NAME_MAX_LENGTH,
  type ZoneShape,
  zoneLabel,
  zoneRectContains,
  zoneTagLabel,
} from '@kaede/shared';
import { describe, expect, it } from 'vitest';

const ZONE_A: ZoneShape = { id: 1n, rect: { x: 400, y: 464, w: 400, h: 192 } };
const ZONE_B: ZoneShape = { id: 2n, rect: { x: 700, y: 464, w: 400, h: 192 } };
const ZONES = [ZONE_A, ZONE_B];

/** A point inside ZONE_A only. */
const IN_A = { x: 500, y: 560 };
/** A point inside the A∩B overlap. */
const IN_BOTH = { x: 750, y: 560 };
/** A point outside both rects but within ZONE_A's exit margin. */
const A_MARGIN = { x: 400 - ZONE_EXIT_MARGIN / 2, y: 560 };
/** A point beyond every rect and margin. */
const FAR = { x: 100, y: 560 };

describe('zoneRectContains', () => {
  it('境界線上を含む(inclusive)', () => {
    const rect = { x: 10, y: 20, w: 30, h: 40 };
    expect(zoneRectContains(rect, { x: 10, y: 20 })).toBe(true);
    expect(zoneRectContains(rect, { x: 40, y: 60 })).toBe(true);
    expect(zoneRectContains(rect, { x: 41, y: 30 })).toBe(false);
    expect(zoneRectContains(rect, { x: 20, y: 19 })).toBe(false);
  });
});

describe('resolveZoneOccupancy', () => {
  it('未所属で矩形に入ると入室、矩形外なら未所属のまま', () => {
    expect(resolveZoneOccupancy({ position: IN_A, zones: ZONES, currentZoneId: undefined })).toBe(
      1n,
    );
    expect(
      resolveZoneOccupancy({ position: FAR, zones: ZONES, currentZoneId: undefined }),
    ).toBeUndefined();
  });

  it('退室はヒステリシス: マージン内は在室のまま、越えたら退室', () => {
    expect(resolveZoneOccupancy({ position: A_MARGIN, zones: ZONES, currentZoneId: 1n })).toBe(1n);
    expect(
      resolveZoneOccupancy({ position: FAR, zones: ZONES, currentZoneId: 1n }),
    ).toBeUndefined();
  });

  it('マージン内に立っていても未所属からの入室は起きない(入室は素の矩形)', () => {
    expect(
      resolveZoneOccupancy({ position: A_MARGIN, zones: ZONES, currentZoneId: undefined }),
    ).toBeUndefined();
  });

  it('重なり合うゾーンでは現在のゾーンが優先され、未所属なら id の小さい方に入る', () => {
    expect(resolveZoneOccupancy({ position: IN_BOTH, zones: ZONES, currentZoneId: 2n })).toBe(2n);
    expect(
      resolveZoneOccupancy({ position: IN_BOTH, zones: ZONES, currentZoneId: undefined }),
    ).toBe(1n);
  });

  it('現在の id がこのマップのゾーンに無ければ(削除・移設)素の入室判定に落ちる', () => {
    expect(resolveZoneOccupancy({ position: IN_A, zones: ZONES, currentZoneId: 99n })).toBe(1n);
    expect(
      resolveZoneOccupancy({ position: FAR, zones: ZONES, currentZoneId: 99n }),
    ).toBeUndefined();
  });
});

describe('clampZoneRect', () => {
  it('中心からの矩形をそのまま返す(境界内)', () => {
    expect(
      clampZoneRect({ centerX: 500, centerY: 400, w: 200, h: 100, mapWidth: 1920, mapHeight: 720 }),
    ).toEqual({ x: 400, y: 350, w: 200, h: 100 });
  });

  it('マップ端では境界内へずらす', () => {
    expect(
      clampZoneRect({ centerX: 10, centerY: 700, w: 200, h: 100, mapWidth: 1920, mapHeight: 720 }),
    ).toEqual({ x: 0, y: 620, w: 200, h: 100 });
    expect(
      clampZoneRect({
        centerX: 1900,
        centerY: 10,
        w: 200,
        h: 100,
        mapWidth: 1920,
        mapHeight: 720,
      }),
    ).toEqual({ x: 1720, y: 0, w: 200, h: 100 });
  });

  it('マップより大きな矩形はマップいっぱいに縮む', () => {
    expect(
      clampZoneRect({
        centerX: 100,
        centerY: 100,
        w: 5000,
        h: 5000,
        mapWidth: 1920,
        mapHeight: 720,
      }),
    ).toEqual({ x: 0, y: 0, w: 1920, h: 720 });
  });
});

describe('evaluateZoneSpec', () => {
  it('正規化した名前とサイズを受理する', () => {
    expect(evaluateZoneSpec({ name: '  会議室　A ', w: 360, h: 240 })).toEqual({
      ok: true,
      name: '会議室 A',
      w: 360,
      h: 240,
    });
  });

  it('空の名前・上限超えの名前を拒否する', () => {
    expect(evaluateZoneSpec({ name: '   ', w: 360, h: 240 })).toEqual({
      ok: false,
      reason: 'empty',
    });
    expect(
      evaluateZoneSpec({ name: 'あ'.repeat(ZONE_NAME_MAX_LENGTH + 1), w: 360, h: 240 }),
    ).toEqual({ ok: false, reason: 'too-long' });
  });

  it('サイズの下限・上限・非数を拒否する', () => {
    expect(evaluateZoneSpec({ name: '会議室', w: ZONE_MIN_SIZE - 1, h: 240 })).toEqual({
      ok: false,
      reason: 'invalid-size',
    });
    expect(evaluateZoneSpec({ name: '会議室', w: 360, h: ZONE_MAX_SIZE + 1 })).toEqual({
      ok: false,
      reason: 'invalid-size',
    });
    expect(evaluateZoneSpec({ name: '会議室', w: Number.NaN, h: 240 })).toEqual({
      ok: false,
      reason: 'invalid-size',
    });
  });

  it('境界サイズは受理する', () => {
    expect(evaluateZoneSpec({ name: '会議室', w: ZONE_MIN_SIZE, h: ZONE_MAX_SIZE }).ok).toBe(true);
  });
});

describe('sortedZoneRows / sortedHuddleRows', () => {
  const rows = [
    { id: 5n, kind: 'zone' },
    { id: 2n, kind: 'huddle' },
    { id: 1n, kind: 'zone' },
    { id: 4n, kind: 'huddle' },
    { id: 3n, kind: 'unknown-future-kind' },
  ];

  it('自分の kind 以外を落とし、id 昇順に並べる', () => {
    expect(sortedZoneRows(rows).map((row) => row.id)).toEqual([1n, 5n]);
    expect(sortedHuddleRows(rows).map((row) => row.id)).toEqual([2n, 4n]);
  });
});

describe('ラベル合成', () => {
  it('クローズドは 🔒 前置、在室タグは 📍 前置', () => {
    expect(zoneLabel('会議室A', false)).toBe('会議室A');
    expect(zoneLabel('会議室A', true)).toBe('🔒 会議室A');
    expect(zoneTagLabel('会議室A')).toBe('📍 会議室A');
  });

  it('立ち話はオープン 💬・クローズド 🤫 前置', () => {
    expect(huddleLabel('雑談', false)).toBe('💬 雑談');
    expect(huddleLabel('雑談', true)).toBe('🤫 雑談');
  });

  it('groupTagLabel は kind で出し分け、未知の kind は undefined', () => {
    expect(groupTagLabel({ kind: 'zone', name: '会議室A', closed: true })).toBe('📍 会議室A');
    expect(groupTagLabel({ kind: 'huddle', name: '雑談', closed: false })).toBe('💬 雑談');
    expect(groupTagLabel({ kind: 'huddle', name: '雑談', closed: true })).toBe('🤫 雑談');
    expect(groupTagLabel({ kind: 'future-kind', name: 'x', closed: false })).toBeUndefined();
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

describe('isMeetingIdLike', () => {
  it('プロバイダ発行の UUID 形式だけを受理する', () => {
    expect(isMeetingIdLike('bbb8280d-7d30-430b-a3a0-78802ed5617c')).toBe(true);
    expect(isMeetingIdLike('')).toBe(false);
    expect(isMeetingIdLike('bbb8280d-7d30-430b-a3a0')).toBe(false);
    expect(isMeetingIdLike('BBB8280D-7D30-430B-A3A0-78802ED5617C')).toBe(false);
    expect(isMeetingIdLike('bbb8280d-7d30-430b-a3a0-78802ed5617c\n')).toBe(false);
    expect(isMeetingIdLike("'; DROP TABLE group_call; --")).toBe(false);
  });
});

describe('recording id / status', () => {
  it('recordingId は meetingId と同じ UUID 形', () => {
    expect(isRecordingIdLike('97cb480d-5840-4528-ace3-919b5e386c68')).toBe(true);
    expect(isRecordingIdLike('not-a-uuid')).toBe(false);
  });

  it('行の status 語彙は4値の完全一致', () => {
    expect(isRecordingStatus(RECORDING_STATUS_RECORDING)).toBe(true);
    expect(isRecordingStatus(RECORDING_STATUS_UPLOADED)).toBe(true);
    expect(isRecordingStatus('RECORDING')).toBe(false);
    expect(isRecordingStatus('done')).toBe(false);
  });

  it('プロバイダの UPPER_SNAKE を行語彙へ写す', () => {
    expect(recordingStatusFromProvider('INVOKED')).toBe(RECORDING_STATUS_RECORDING);
    expect(recordingStatusFromProvider('RECORDING')).toBe(RECORDING_STATUS_RECORDING);
    expect(recordingStatusFromProvider('UPLOADING')).toBe('uploading');
    expect(recordingStatusFromProvider('UPLOADED')).toBe(RECORDING_STATUS_UPLOADED);
    expect(recordingStatusFromProvider('ERRORED')).toBe('errored');
    expect(recordingStatusFromProvider('UNKNOWN')).toBeUndefined();
  });
});
