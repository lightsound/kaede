import { describe, expect, it } from 'vite-plus/test';
import { COLUMN_INSET, type ColumnControl, columnBand } from '../src/leftColumn';

const CONTROLS: ColumnControl[] = ['name', 'status', 'huddle', 'call'];

describe('columnBand', () => {
  it('stacks the bands from the bottom up', () => {
    expect(CONTROLS.map((control) => columnBand(control).order)).toEqual([0, 1, 2, 3]);
  });

  it('reserves the long-standing band bottoms 12, 58, 148, 220', () => {
    expect(COLUMN_INSET).toBe(12);
    expect(CONTROLS.map((control) => columnBand(control).minHeight)).toEqual([46, 90, 72, 0]);
  });
});
