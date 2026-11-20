import { describe, expect, it } from 'vite-plus/test';
import {
  CLIMB_SPEED,
  type CollisionMap,
  DEFAULT_MAP,
  DT,
  GROUND_TOP,
  JUMP_VELOCITY,
  MOVE_SPEED,
  PLAYER_HALF_H,
  PLAYER_HALF_W,
  type PlayerInput,
  type PlayerState,
  packInput,
  ROPE_JUMP_VELOCITY,
  replayInputs,
  SPAWN_X,
  stepPlayer,
  unpackInput,
  WORLD_HEIGHT,
  WORLD_WIDTH,
} from '../src/index';

const NO_INPUT: PlayerInput = { left: false, right: false, jump: false, up: false, down: false };

function spawn(overrides: Partial<PlayerState> = {}): PlayerState {
  return { x: SPAWN_X, y: 200, vx: 0, vy: 0, facing: 1, onGround: false, rope: -1, ...overrides };
}

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
    expect(jumped.vy).toBeLessThan(0);
    expect(jumped.vy).toBeGreaterThan(JUMP_VELOCITY);
    expect(jumped.y).toBeLessThan(grounded.y);

    const airborne = spawn({ y: 300, onGround: false });
    const noLift = stepPlayer(airborne, { ...NO_INPUT, jump: true }, DEFAULT_MAP);
    expect(noLift.y).toBeGreaterThan(airborne.y);
  });

  it('lands on a platform top by jumping up to it', () => {
    const platformTop = 540;
    const groundedRightOfPlatform = spawn({ x: 720, y: GROUNDED_Y, onGround: true });

    let s = stepPlayer(
      groundedRightOfPlatform,
      { ...NO_INPUT, jump: true, left: true },
      DEFAULT_MAP,
    );
    for (let i = 0; i < 240 && !(s.onGround && s.y < GROUNDED_Y); i++) {
      s = stepPlayer(s, { ...NO_INPUT, left: true }, DEFAULT_MAP);
    }
    expect(s.onGround).toBe(true);
    expect(s.y).toBe(platformTop - PLAYER_HALF_H);
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
      platforms: [],
      ropes: [],
    };
    const start = spawn({ x: 300, y: GROUNDED_Y, onGround: true });
    const after = run(start, { ...NO_INPUT, right: true }, 120, wall);
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
    const input: PlayerInput = { left: false, right: true, jump: true, up: false, down: false };
    const stateCopy = { ...state };
    const inputCopy = { ...input };

    const a = stepPlayer(state, input, DEFAULT_MAP);
    const b = stepPlayer(state, input, DEFAULT_MAP);

    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(state).toEqual(stateCopy);
    expect(input).toEqual(inputCopy);
    expect(a.rope).toBe(-1);
  });
});

describe('one-way platforms', () => {
  const PLAT_LEFT = 420;
  const PLAT_RIGHT = 680;
  const PLAT_TOP = 540;
  const STAND_ON_PLAT = PLAT_TOP - PLAYER_HALF_H;

  it('jumping from below rises up THROUGH the platform without a head bonk', () => {
    const x = 500;
    const start = spawn({ x, y: GROUNDED_Y, onGround: true });

    let s = stepPlayer(start, { ...NO_INPUT, jump: true }, DEFAULT_MAP);
    expect(s.onGround).toBe(false);

    let prevY = s.y;
    while (s.vy < 0) {
      s = stepPlayer(s, NO_INPUT, DEFAULT_MAP);
      expect(s.y).toBeLessThanOrEqual(prevY);
      expect(s.onGround).toBe(false);
      prevY = s.y;
    }
    expect(s.y).toBeLessThan(STAND_ON_PLAT);

    s = run(s, NO_INPUT, 240);
    expect(s.onGround).toBe(true);
    expect(s.y).toBe(STAND_ON_PLAT);
    expect(s.x).toBeGreaterThanOrEqual(PLAT_LEFT);
    expect(s.x).toBeLessThanOrEqual(PLAT_RIGHT);
  });

  it('drops through a platform with down+jump and settles on the ground', () => {
    // x=550 is also rope 0's x: down+jump must mean "drop through", taking
    // priority over the down-grab (which fires only without jump).
    const start = spawn({ x: 550, y: STAND_ON_PLAT, onGround: true });
    const dropInput = { ...NO_INPUT, down: true, jump: true };

    const after1 = stepPlayer(start, dropInput, DEFAULT_MAP);
    expect(after1.onGround).toBe(false);
    expect(after1.y).toBeGreaterThan(STAND_ON_PLAT);

    let s = after1;
    let snappedBack = false;
    for (let i = 0; i < 200; i++) {
      s = stepPlayer(s, dropInput, DEFAULT_MAP);
      if (s.onGround && s.y !== GROUNDED_Y) snappedBack = true;
    }
    expect(snappedBack).toBe(false);
    expect(s.onGround).toBe(true);
    expect(s.y).toBe(GROUNDED_Y);
  });
});

describe('down+jump on solid ground', () => {
  it('does not jump (stays grounded)', () => {
    const start = spawn({ x: SPAWN_X, y: GROUNDED_Y, onGround: true });
    const input = { ...NO_INPUT, down: true, jump: true };

    let s = start;
    for (let i = 0; i < 5; i++) {
      s = stepPlayer(s, input, DEFAULT_MAP);
      expect(s.y).toBe(GROUNDED_Y);
      expect(s.onGround).toBe(true);
    }
  });
});

describe('rope climbing', () => {
  const ROPE0 = DEFAULT_MAP.ropes[0];

  it('grabs a rope from the ground by holding up', () => {
    const start = spawn({ x: 550, y: GROUNDED_Y, onGround: true });
    const grabbed = stepPlayer(start, { ...NO_INPUT, up: true }, DEFAULT_MAP);

    expect(grabbed.rope).toBe(0);
    expect(grabbed.x).toBe(ROPE0.x);
    expect(grabbed.vx).toBe(0);
    expect(grabbed.vy).toBe(0);
    expect(grabbed.onGround).toBe(false);
    expect(grabbed.y).toBe(GROUNDED_Y);
  });

  it('climbs up the rope at CLIMB_SPEED while up is held', () => {
    const grabbed = spawn({ x: 550, y: GROUNDED_Y, onGround: false, rope: 0 });

    const up1 = stepPlayer(grabbed, { ...NO_INPUT, up: true }, DEFAULT_MAP);
    expect(up1.rope).toBe(0);
    expect(up1.y).toBe(GROUNDED_Y - CLIMB_SPEED * DT);

    const up2 = stepPlayer(up1, { ...NO_INPUT, up: true }, DEFAULT_MAP);
    expect(up2.rope).toBe(0);
    expect(up2.y).toBeLessThan(up1.y);
  });

  function climbOffTop(state: PlayerState, ropeIndex: number): PlayerState {
    let s = state;
    for (let i = 0; i < 200 && s.rope === ropeIndex; i++) {
      s = stepPlayer(s, { ...NO_INPUT, up: true }, DEFAULT_MAP);
    }
    return s;
  }

  it('exits at the top onto the platform the rope hangs from', () => {
    const s = climbOffTop(spawn({ x: 550, y: GROUNDED_Y, onGround: false, rope: 0 }), 0);
    expect(s.rope).toBe(-1);
    expect(s.onGround).toBe(true);
    expect(s.x).toBe(550);
    expect(s.y).toBe(ROPE0.top - PLAYER_HALF_H);

    // Standing at the top-exit spot and holding up does NOT re-grab the rope:
    // the up-grab requires y > rope.top, but y here equals top - 24 < top.
    const again = stepPlayer(s, { ...NO_INPUT, up: true }, DEFAULT_MAP);
    expect(again.rope).toBe(-1);
    expect(again.onGround).toBe(true);
    expect(again.y).toBe(ROPE0.top - PLAYER_HALF_H);
    expect(again.x).toBe(550);
  });

  it('grabs a hanging rope from a platform top by holding down', () => {
    const start = spawn({ x: 550, y: 540 - PLAYER_HALF_H, onGround: true });
    const grabbed = stepPlayer(start, { ...NO_INPUT, down: true }, DEFAULT_MAP);

    expect(grabbed.rope).toBe(0);
    expect(grabbed.x).toBe(550);
    expect(grabbed.y).toBe(ROPE0.top);
    expect(grabbed.onGround).toBe(false);
    expect(grabbed.vx).toBe(0);
    expect(grabbed.vy).toBe(0);
  });

  it('lets go at the bottom and settles on the ground', () => {
    const nearBottom = spawn({ x: 550, y: ROPE0.bottom - 1, onGround: false, rope: 0 });
    const detach = stepPlayer(nearBottom, { ...NO_INPUT, down: true }, DEFAULT_MAP);
    expect(detach.rope).toBe(-1);
    expect(detach.y).toBe(ROPE0.bottom);
    expect(detach.onGround).toBe(false);

    const settled = run(detach, NO_INPUT, 60);
    expect(settled.onGround).toBe(true);
    expect(settled.rope).toBe(-1);
    expect(settled.y).toBe(GROUNDED_Y);
  });

  it('jumps off the rope with a direction, applying horizontal input the same tick', () => {
    const midRope = spawn({ x: 550, y: 580, onGround: false, rope: 0 });
    const jumped = stepPlayer(midRope, { ...NO_INPUT, jump: true, left: true }, DEFAULT_MAP);

    expect(jumped.rope).toBe(-1);
    expect(jumped.vy).toBe(ROPE_JUMP_VELOCITY + 2400 * DT);
    expect(jumped.vx).toBe(-MOVE_SPEED);
    expect(jumped.facing).toBe(-1);
    expect(jumped.x).toBeLessThan(550);
  });

  it('a plain jump (no direction) on a rope keeps climbing', () => {
    const midRope = spawn({ x: 550, y: 580, onGround: false, rope: 0 });
    const stillOn = stepPlayer(midRope, { ...NO_INPUT, jump: true }, DEFAULT_MAP);
    expect(stillOn.rope).toBe(0);
    expect(stillOn.y).toBe(580);
    expect(stillOn.vy).toBe(0);
  });

  it('the high platform is reachable only via its rope', () => {
    const rope2 = DEFAULT_MAP.ropes[2];
    expect(rope2.x).toBe(1400);

    const start = spawn({ x: 1400, y: 540 - PLAYER_HALF_H, onGround: true });
    const grabbed = stepPlayer(start, { ...NO_INPUT, up: true }, DEFAULT_MAP);
    expect(grabbed.rope).toBe(2);
    expect(grabbed.x).toBe(1400);

    const s = climbOffTop(grabbed, 2);
    expect(s.rope).toBe(-1);
    expect(s.onGround).toBe(true);
    expect(s.x).toBe(1400);
    expect(s.y).toBe(rope2.top - PLAYER_HALF_H);
  });
});

describe('replayInputs', () => {
  it('is the same as stepping each packed byte by hand', () => {
    const start = spawn({ y: GROUND_TOP - PLAYER_HALF_H, onGround: true });
    const packed = [
      packInput({ ...NO_INPUT, right: true }),
      packInput({ ...NO_INPUT, right: true, jump: true }),
      packInput({ ...NO_INPUT, right: true }),
      packInput(NO_INPUT),
      packInput({ ...NO_INPUT, left: true }),
    ];

    let expected = start;
    for (const byte of packed) expected = stepPlayer(expected, unpackInput(byte), DEFAULT_MAP);

    expect(replayInputs(start, packed, DEFAULT_MAP)).toEqual(expected);
  });

  it('applies a Uint8Array batch, which is what the server receives', () => {
    const start = spawn({ y: GROUND_TOP - PLAYER_HALF_H, onGround: true });
    const right = packInput({ ...NO_INPUT, right: true });
    const batch = new Uint8Array([right, right, right]);

    expect(replayInputs(start, batch, DEFAULT_MAP)).toEqual(run(start, unpackInput(right), 3));
  });

  it('returns the input state untouched for an empty batch', () => {
    const start = spawn();
    expect(replayInputs(start, [], DEFAULT_MAP)).toBe(start);
  });

  it('never mutates the state it is given', () => {
    const start = spawn({ y: GROUND_TOP - PLAYER_HALF_H, onGround: true });
    const snapshot = { ...start };
    replayInputs(start, [packInput({ ...NO_INPUT, right: true, jump: true })], DEFAULT_MAP);
    expect(start).toEqual(snapshot);
  });
});
