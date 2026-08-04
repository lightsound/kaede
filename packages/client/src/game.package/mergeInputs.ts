import type { PlayerInput } from '@kaede/shared';

/** Field-wise OR of two inputs, so multiple sources (keyboard, touch) combine. */
export function mergeInputs(a: PlayerInput, b: PlayerInput): PlayerInput {
  return {
    left: a.left || b.left,
    right: a.right || b.right,
    up: a.up || b.up,
    down: a.down || b.down,
    jump: a.jump || b.jump,
  };
}
