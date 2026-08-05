import {
  clampZoneRect,
  evaluateZoneSpec,
  resolveZoneOccupancy,
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

describe('sortedZoneRows', () => {
  it('zone 以外の kind を落とし、id 昇順に並べる', () => {
    const rows = [
      { id: 5n, kind: 'zone' },
      { id: 2n, kind: 'huddle' },
      { id: 1n, kind: 'zone' },
      { id: 3n, kind: 'unknown-future-kind' },
    ];
    expect(sortedZoneRows(rows).map((row) => row.id)).toEqual([1n, 5n]);
  });
});

describe('ラベル合成', () => {
  it('クローズドは 🔒 前置、在室タグは 📍 前置', () => {
    expect(zoneLabel('会議室A', false)).toBe('会議室A');
    expect(zoneLabel('会議室A', true)).toBe('🔒 会議室A');
    expect(zoneTagLabel('会議室A')).toBe('📍 会議室A');
  });
});
