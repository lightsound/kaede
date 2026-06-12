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

/**
 * All 64 combinations of the six input bitflags.
 * Bit mapping (must match src/input.ts): 1=left, 2=right, 4=jump, 8=up, 16=down, 32=attack.
 */
const ALL_INPUTS: PlayerInput[] = Array.from({ length: 64 }, (_, n) => ({
  left: (n & 1) !== 0,
  right: (n & 2) !== 0,
  jump: (n & 4) !== 0,
  up: (n & 8) !== 0,
  down: (n & 16) !== 0,
  attack: (n & 32) !== 0,
}));

describe('packInput / unpackInput', () => {
  it('round-trips every input combination', () => {
    for (const input of ALL_INPUTS) {
      expect(unpackInput(packInput(input))).toEqual(input);
    }
  });

  it('packs into the u8 range 0..63', () => {
    for (const input of ALL_INPUTS) {
      const p = packInput(input);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(63);
    }
  });

  it('packs each bit at its documented position', () => {
    const base = { left: false, right: false, jump: false, up: false, down: false, attack: false };
    expect(packInput({ ...base, left: true })).toBe(1);
    expect(packInput({ ...base, right: true })).toBe(2);
    expect(packInput({ ...base, jump: true })).toBe(4);
    expect(packInput({ ...base, up: true })).toBe(8);
    expect(packInput({ ...base, down: true })).toBe(16);
    expect(packInput({ ...base, attack: true })).toBe(32);
  });
});

describe('replay determinism', () => {
  it('replaying a fixed input sequence yields identical state both times', () => {
    // This is what makes server replay bit-identical to client prediction.
    // Sequence exercises movement, jump, climb (up/down) and attack bits, up to 63.
    const seq = [2, 2, 6, 24, 8, 1, 1, 20, 4, 16, 34, 32, 63, 0, 3].map(unpackInput);
    const start: PlayerState = {
      x: SPAWN_X,
      y: 200,
      vx: 0,
      vy: 0,
      facing: 1,
      onGround: false,
      rope: -1,
      attackCooldown: 0,
      mapId: 0,
    };

    const replay = (): PlayerState => {
      let s = start;
      for (const input of seq) s = stepPlayer(s, input, [DEFAULT_MAP]);
      return s;
    };

    expect(replay()).toEqual(replay());
  });
});
