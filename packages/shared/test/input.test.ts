import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAP,
  SPAWN_X,
  packInput,
  stepPlayer,
  unpackInput,
  type PlayerInput,
  type PlayerState,
} from '../src/index';

/** All 8 combinations of the three input bitflags. */
const ALL_INPUTS: PlayerInput[] = Array.from({ length: 8 }, (_, n) => ({
  left: (n & 1) !== 0,
  right: (n & 2) !== 0,
  jump: (n & 4) !== 0,
}));

describe('packInput / unpackInput', () => {
  it('round-trips every input combination', () => {
    for (const input of ALL_INPUTS) {
      expect(unpackInput(packInput(input))).toEqual(input);
    }
  });

  it('packs into the u8 range 0..7', () => {
    for (const input of ALL_INPUTS) {
      const p = packInput(input);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(7);
    }
  });
});

describe('replay determinism', () => {
  it('replaying a fixed input sequence yields identical state both times', () => {
    // This is what makes server replay bit-identical to client prediction.
    const seq = [2, 2, 6, 0, 1, 1, 4, 2, 0, 3].map(unpackInput);
    const start: PlayerState = { x: SPAWN_X, y: 200, vx: 0, vy: 0, facing: 1, onGround: false };

    const replay = (): PlayerState => {
      let s = start;
      for (const input of seq) s = stepPlayer(s, input, DEFAULT_MAP);
      return s;
    };

    expect(replay()).toEqual(replay());
  });
});
