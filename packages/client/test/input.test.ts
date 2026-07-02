import type { PlayerInput } from '@maple/shared';
import { describe, expect, it } from 'vitest';
import { mergeInputs } from '../src/game/input';

const NONE: PlayerInput = { left: false, right: false, up: false, down: false, jump: false };

describe('mergeInputs', () => {
  it('is a field-wise OR of both sources', () => {
    const keyboard: PlayerInput = { ...NONE, left: true, jump: true };
    const touch: PlayerInput = { ...NONE, left: true, up: true };
    expect(mergeInputs(keyboard, touch)).toEqual({
      left: true,
      right: false,
      up: true,
      down: false,
      jump: true,
    });
  });

  it('returns all-false when neither source is active', () => {
    expect(mergeInputs(NONE, NONE)).toEqual(NONE);
  });

  it('takes every field from a single active source, in either position', () => {
    const all: PlayerInput = { left: true, right: true, up: true, down: true, jump: true };
    expect(mergeInputs(all, NONE)).toEqual(all);
    expect(mergeInputs(NONE, all)).toEqual(all);
  });
});
