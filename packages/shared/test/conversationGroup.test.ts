import { groupTagLabel, sortedHuddleRows, sortedZoneRows } from '@kaede/shared';
import { describe, expect, it } from 'vitest';

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
  it('groupTagLabel は kind で出し分け、未知の kind は undefined', () => {
    expect(groupTagLabel({ kind: 'zone', name: '会議室A', closed: true })).toBe('📍 会議室A');
    expect(groupTagLabel({ kind: 'huddle', name: '雑談', closed: false })).toBe('💬 雑談');
    expect(groupTagLabel({ kind: 'huddle', name: '雑談', closed: true })).toBe('🤫 雑談');
    expect(groupTagLabel({ kind: 'future-kind', name: 'x', closed: false })).toBeUndefined();
  });
});
