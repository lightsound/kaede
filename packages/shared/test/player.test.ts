import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAP,
  GROUND_TOP,
  JUMP_VELOCITY,
  MOVE_SPEED,
  PLAYER_HALF_H,
  PLAYER_HALF_W,
  SPAWN_X,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  stepPlayer,
  type CollisionMap,
  type PlayerInput,
  type PlayerState,
} from '../src/index';

const NO_INPUT: PlayerInput = { left: false, right: false, jump: false };

function spawn(overrides: Partial<PlayerState> = {}): PlayerState {
  return { x: SPAWN_X, y: 200, vx: 0, vy: 0, facing: 1, onGround: false, ...overrides };
}

/** Run the sim for n ticks, threading the same input through each tick. */
function run(state: PlayerState, input: PlayerInput, n: number, map = DEFAULT_MAP): PlayerState {
  let s = state;
  for (let i = 0; i < n; i++) s = stepPlayer(s, input, map);
  return s;
}

const GROUNDED_Y = GROUND_TOP - PLAYER_HALF_H;

describe('stepPlayer', () => {
  it('falls under gravity and settles on the ground', () => {
    const after1 = stepPlayer(spawn(), NO_INPUT, DEFAULT_MAP);
    expect(after1.vy).toBeGreaterThan(0);
    expect(after1.y).toBeGreaterThan(200);

    const settled = run(spawn(), NO_INPUT, 120);
    expect(settled.y).toBe(GROUNDED_Y);
    expect(settled.vy).toBe(0);
    expect(settled.onGround).toBe(true);
  });

  it('can jump only when grounded', () => {
    const grounded = run(spawn(), NO_INPUT, 120);
    expect(grounded.onGround).toBe(true);

    const jumped = stepPlayer(grounded, { ...NO_INPUT, jump: true }, DEFAULT_MAP);
    expect(jumped.onGround).toBe(false);
    // After applying gravity for one tick the upward velocity is still negative.
    expect(jumped.vy).toBeLessThan(0);
    expect(jumped.vy).toBeGreaterThan(JUMP_VELOCITY);
    expect(jumped.y).toBeLessThan(grounded.y);

    // Jumping mid-air does nothing.
    const airborne = spawn({ y: 300, onGround: false });
    const noLift = stepPlayer(airborne, { ...NO_INPUT, jump: true }, DEFAULT_MAP);
    expect(noLift.y).toBeGreaterThan(airborne.y);
  });

  it('lands on a platform top by jumping up to it', () => {
    // Platform { x: 420, y: 540, w: 260, h: 24 }, top at y=540. Jump from the
    // ground just to the right of it, then drift left over the top and land.
    const platformTop = 540;
    const groundedRightOfPlatform = spawn({ x: 720, y: GROUNDED_Y, onGround: true });

    let s = stepPlayer(groundedRightOfPlatform, { ...NO_INPUT, jump: true, left: true }, DEFAULT_MAP);
    for (let i = 0; i < 240 && !(s.onGround && s.y < GROUNDED_Y); i++) {
      s = stepPlayer(s, { ...NO_INPUT, left: true }, DEFAULT_MAP);
    }
    expect(s.onGround).toBe(true);
    expect(s.y).toBe(platformTop - PLAYER_HALF_H);
    // And we are horizontally within the platform span.
    expect(s.x).toBeGreaterThanOrEqual(420);
    expect(s.x).toBeLessThanOrEqual(680);
  });

  it('is stopped horizontally by a wall-like solid', () => {
    const wall: CollisionMap = {
      width: WORLD_WIDTH,
      height: WORLD_HEIGHT,
      solids: [
        { x: 0, y: GROUND_TOP, w: WORLD_WIDTH, h: WORLD_HEIGHT - GROUND_TOP },
        { x: 400, y: 0, w: 40, h: GROUND_TOP },
      ],
    };
    const start = spawn({ x: 300, y: GROUNDED_Y, onGround: true });
    const after = run(start, { ...NO_INPUT, right: true }, 120, wall);
    // Pushed flush against the wall's left face, never through it.
    expect(after.x).toBe(400 - PLAYER_HALF_W);
    expect(after.facing).toBe(1);
  });

  it('keeps facing when idle and flips when moving', () => {
    const facingLeft = spawn({ facing: -1, onGround: true, y: GROUNDED_Y });
    const idle = stepPlayer(facingLeft, NO_INPUT, DEFAULT_MAP);
    expect(idle.facing).toBe(-1);
    const moved = stepPlayer(facingLeft, { ...NO_INPUT, right: true }, DEFAULT_MAP);
    expect(moved.facing).toBe(1);
    expect(moved.vx).toBe(MOVE_SPEED);
  });

  it('clamps x to the map bounds', () => {
    const start = spawn({ x: 10, y: GROUNDED_Y, onGround: true });
    const after = run(start, { ...NO_INPUT, left: true }, 30);
    expect(after.x).toBe(PLAYER_HALF_W);
  });

  it('is pure and deterministic and does not mutate inputs', () => {
    const state = spawn({ y: 250, vy: 50 });
    const input: PlayerInput = { left: false, right: true, jump: true };
    const stateCopy = { ...state };
    const inputCopy = { ...input };

    const a = stepPlayer(state, input, DEFAULT_MAP);
    const b = stepPlayer(state, input, DEFAULT_MAP);

    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    // Arguments are untouched.
    expect(state).toEqual(stateCopy);
    expect(input).toEqual(inputCopy);
  });
});
