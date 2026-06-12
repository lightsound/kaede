import type { PlayerInput } from './types';

/** Bit flags for one tick of input packed into a u8 (0..7). */
const LEFT = 1;
const RIGHT = 2;
const JUMP = 4;

export function packInput(i: PlayerInput): number {
  return (i.left ? LEFT : 0) | (i.right ? RIGHT : 0) | (i.jump ? JUMP : 0);
}

export function unpackInput(p: number): PlayerInput {
  return { left: (p & LEFT) !== 0, right: (p & RIGHT) !== 0, jump: (p & JUMP) !== 0 };
}
