import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAP,
  type PlayerInput,
  type PlayerState,
  packInput,
  SPAWN_X,
  stepPlayer,
  unpackInput,
} from '../src/index';

/**
 * All 32 combinations of the five input bitflags.
 * Bit mapping (must match src/input.ts): 1=left, 2=right, 4=jump, 8=up, 16=down.
 */
const ALL_INPUTS: PlayerInput[] = Array.from({ length: 32 }, (_, n) => ({
  left: (n & 1) !== 0,
  right: (n & 2) !== 0,
  jump: (n & 4) !== 0,
  up: (n & 8) !== 0,
  down: (n & 16) !== 0,
}));

describe('packInput / unpackInput', () => {
  it('round-trips every input combination', () => {
    for (const input of ALL_INPUTS) {
      expect(unpackInput(packInput(input))).toEqual(input);
    }
  });

  it('packs into the u8 range 0..31', () => {
    for (const input of ALL_INPUTS) {
      const p = packInput(input);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(31);
    }
  });

  it('packs each bit at its documented position', () => {
    expect(packInput({ left: true, right: false, jump: false, up: false, down: false })).toBe(1);
    expect(packInput({ left: false, right: true, jump: false, up: false, down: false })).toBe(2);
    expect(packInput({ left: false, right: false, jump: true, up: false, down: false })).toBe(4);
    expect(packInput({ left: false, right: false, jump: false, up: true, down: false })).toBe(8);
    expect(packInput({ left: false, right: false, jump: false, up: false, down: true })).toBe(16);
  });
});

describe('replay determinism', () => {
  it('replaying a fixed input sequence yields identical state both times', () => {
    // This is what makes server replay bit-identical to client prediction.
    // Sequence exercises movement, jump, and climb (up/down) bits, values up to 31.
    const seq = [2, 2, 6, 24, 8, 1, 1, 20, 4, 16, 31, 0, 3].map(unpackInput);
    const start: PlayerState = {
      x: SPAWN_X,
      y: 200,
      vx: 0,
      vy: 0,
      facing: 1,
      onGround: false,
      rope: -1,
    };

    const replay = (): PlayerState => {
      let s = start;
      for (const input of seq) s = stepPlayer(s, input, DEFAULT_MAP);
      return s;
    };

    expect(replay()).toEqual(replay());
  });
});
