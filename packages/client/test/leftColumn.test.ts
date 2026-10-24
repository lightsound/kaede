import { describe, expect, it } from 'vitest';
import { bandBottom, COLUMN_INSET } from '../src/leftColumn';

describe('bandBottom', () => {
  it('starts the bottom band at the column inset', () => {
    expect(bandBottom('name')).toBe(COLUMN_INSET);
  });

  it('stacks each band on the heights of the bands below it', () => {
    // The column's layout: the status over the name form, the huddle
    // control over the status, the call dock on top.
    expect([
      bandBottom('name'),
      bandBottom('status'),
      bandBottom('huddle'),
      bandBottom('call'),
    ]).toEqual([12, 58, 148, 220]);
  });
});
