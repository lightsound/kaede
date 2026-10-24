import { describe, expect, it } from 'vitest';
import { COLUMN_INSET, type ColumnControl, columnBand } from '../src/leftColumn';

const CONTROLS: ColumnControl[] = ['name', 'status', 'huddle', 'call'];

describe('columnBand', () => {
  it('stacks the bands from the bottom up', () => {
    // The column's layout: the status over the name form, the huddle
    // control over the status, the call dock on top.
    expect(CONTROLS.map((control) => columnBand(control).order)).toEqual([0, 1, 2, 3]);
  });

  it('reserves the long-standing band bottoms 12, 58, 148, 220', () => {
    // Stacked upward from the inset, each band starts where the heights
    // reserved below it end: 12, 12 + 46, 58 + 90, 148 + 72.
    expect(COLUMN_INSET).toBe(12);
    expect(CONTROLS.map((control) => columnBand(control).minHeight)).toEqual([46, 90, 72, 0]);
  });
});
