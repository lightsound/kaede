import type { PlayerInput } from '@maple/shared';
import { describe, expect, it } from 'vitest';
import { mergeInputs } from '../src/game.package/mergeInputs';

const NONE: PlayerInput = { left: false, right: false, up: false, down: false, jump: false };

describe('mergeInputs', () => {
  it('ORs each field, so keyboard and touch combine', () => {
    const keyboard = { ...NONE, left: true, jump: true };
    const touch = { ...NONE, right: true, jump: true };
    expect(mergeInputs(keyboard, touch)).toEqual({
      left: true,
      right: true,
      up: false,
      down: false,
      jump: true,
    });
  });

  it('is identity against an all-false input', () => {
    const held = { ...NONE, up: true, down: true };
    expect(mergeInputs(held, NONE)).toEqual(held);
    expect(mergeInputs(NONE, held)).toEqual(held);
  });

  it('mutates neither argument', () => {
    const a = { ...NONE, left: true };
    const b = { ...NONE, right: true };
    mergeInputs(a, b);
    expect(a).toEqual({ ...NONE, left: true });
    expect(b).toEqual({ ...NONE, right: true });
  });
});
