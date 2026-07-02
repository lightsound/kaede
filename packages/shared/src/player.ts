import {
  CLIMB_SPEED,
  DT,
  GRAVITY,
  JUMP_VELOCITY,
  MAX_FALL_SPEED,
  MOVE_SPEED,
  PLATFORM_DROP_NUDGE,
  PLAYER_HALF_H,
  PLAYER_HALF_W,
  ROPE_GRAB_RANGE,
  ROPE_JUMP_VELOCITY,
} from './constants';
import { type AABB, overlaps, rectBounds } from './physics';
import type { CollisionMap, Facing, PlayerInput, PlayerState, Rect, Rope } from './types';

function box(x: number, y: number): AABB {
  return { cx: x, cy: y, hw: PLAYER_HALF_W, hh: PLAYER_HALF_H };
}

/** True when the player's horizontal span at center x overlaps the rect's. */
function spansRect(x: number, r: Rect): boolean {
  return x + PLAYER_HALF_W > r.x && x - PLAYER_HALF_W < r.x + r.w;
}

/** Normalize a raw facing column (any sign) into the Facing union. */
export function toFacing(f: number): Facing {
  return f < 0 ? -1 : 1;
}

/** Build a PlayerState from a player row's dynamic columns. */
export function stateFromRow(r: {
  x: number;
  y: number;
  vx: number;
  vy: number;
  facing: number;
  onGround: boolean;
  rope: number;
}): PlayerState {
  return {
    x: r.x,
    y: r.y,
    vx: r.vx,
    vy: r.vy,
    facing: toFacing(r.facing),
    onGround: r.onGround,
    rope: r.rope,
  };
}

/**
 * The one-way platform the player's feet are resting on, if any. Landing snaps
 * y to exactly top - PLAYER_HALF_H, so the equality test is exact.
 */
function platformUnderfoot(state: PlayerState, map: CollisionMap): Rect | undefined {
  if (!state.onGround) return undefined;
  return map.platforms.find((p) => state.y + PLAYER_HALF_H === p.y && spansRect(state.x, p));
}

/**
 * The rope the player can grab this tick, or -1. Up grabs a rope whose span
 * continues above the center (climbing on); down grabs a rope hanging below
 * the feet while standing at its top (climbing off a platform edge). Holding
 * jump disables the down-grab so that down+jump means "drop through the
 * platform", not "climb down the rope".
 */
function grabRope(state: PlayerState, input: PlayerInput, map: CollisionMap): number {
  for (let i = 0; i < map.ropes.length; i++) {
    const r = map.ropes[i];
    if (Math.abs(state.x - r.x) > ROPE_GRAB_RANGE) continue;
    if (canGrabUp(state, input, r) || canGrabDown(state, input, r)) return i;
  }
  return -1;
}

/** Up-grab: the rope's span continues above the center (climbing on). */
function canGrabUp(state: PlayerState, input: PlayerInput, r: Rope): boolean {
  return input.up && state.y > r.top && state.y <= r.bottom;
}

/** Down-grab: standing at the top of a rope hanging below the feet. */
function canGrabDown(state: PlayerState, input: PlayerInput, r: Rope): boolean {
  return (
    input.down &&
    !input.jump &&
    state.onGround &&
    state.y < r.top &&
    state.y + PLAYER_HALF_H >= r.top
  );
}

/** Latch onto rope `index`: snap to its x, clamp y into its span. */
function snapToRope(state: PlayerState, rope: Rope, index: number): PlayerState {
  const y = Math.min(Math.max(state.y, rope.top), rope.bottom);
  return { x: rope.x, y, vx: 0, vy: 0, facing: state.facing, onGround: false, rope: index };
}

/**
 * One climbing tick: up/down drive y directly; gravity and collision are
 * suspended. Climbing past the top steps up onto whatever the rope hangs from;
 * sliding past the bottom lets go and falls.
 */
function climbRope(state: PlayerState, input: PlayerInput, rope: Rope): PlayerState {
  const dir = (input.down ? 1 : 0) - (input.up ? 1 : 0);
  const y = state.y + dir * CLIMB_SPEED * DT;
  const base = { x: rope.x, vx: 0, vy: 0, facing: state.facing };
  if (y < rope.top) return { ...base, y: rope.top - PLAYER_HALF_H, onGround: true, rope: -1 };
  if (y > rope.bottom) return { ...base, y: rope.bottom, onGround: false, rope: -1 };
  return { ...base, y, onGround: false, rope: state.rope };
}

/**
 * Horizontal move + resolution. Solids only stop you; vx is unchanged and
 * platforms never block sideways. Returns the resolved x, clamped to the world.
 */
function moveHorizontally(x0: number, y: number, vx: number, map: CollisionMap): number {
  let x = x0 + vx * DT;
  for (const solid of map.solids) {
    if (!overlaps(box(x, y), solid)) continue;
    const s = rectBounds(solid);
    if (vx > 0) x = s.left - PLAYER_HALF_W;
    else if (vx < 0) x = s.right + PLAYER_HALF_W;
  }
  return Math.min(Math.max(x, PLAYER_HALF_W), map.width - PLAYER_HALF_W);
}

interface VerticalMove {
  y: number;
  vy: number;
  onGround: boolean;
}

/** Vertical move + resolution. A downward hit lands us; either hit zeroes vy. */
function moveVertically(x: number, y0: number, vy0: number, map: CollisionMap): VerticalMove {
  let y = y0 + vy0 * DT;
  let vy = vy0;
  let onGround = false;
  for (const solid of map.solids) {
    if (!overlaps(box(x, y), solid)) continue;
    const s = rectBounds(solid);
    if (vy > 0) {
      y = s.top - PLAYER_HALF_H;
      onGround = true;
      vy = 0;
    } else if (vy < 0) {
      y = s.bottom + PLAYER_HALF_H;
      vy = 0;
    }
  }
  return { y, vy, onGround };
}

/**
 * One-way platforms: support only while falling, and only when the feet
 * crossed the platform's top edge during this tick (prevFeet = feet y before
 * the vertical move).
 */
function landOnPlatforms(
  x: number,
  prevFeet: number,
  move: VerticalMove,
  map: CollisionMap,
): VerticalMove {
  if (move.vy <= 0) return move;
  let { y, vy, onGround } = move;
  for (const p of map.platforms) {
    if (!spansRect(x, p)) continue;
    if (prevFeet <= p.y && y + PLAYER_HALF_H >= p.y) {
      y = p.y - PLAYER_HALF_H;
      onGround = true;
      vy = 0;
    }
  }
  return { y, vy, onGround };
}

/** Regular (non-climbing) tick: run + jump/drop + gravity + collision. */
function stepFreeMovement(state: PlayerState, input: PlayerInput, map: CollisionMap): PlayerState {
  const vx = ((input.right ? 1 : 0) - (input.left ? 1 : 0)) * MOVE_SPEED;
  let facing: Facing = state.facing;
  if (vx > 0) facing = 1;
  else if (vx < 0) facing = -1;

  // Jump / drop-through. Holding down turns jump into a platform drop, and
  // suppresses the jump entirely on solid ground.
  let y0 = state.y;
  let vy = state.vy;
  if (input.jump && state.onGround) {
    if (!input.down) {
      vy = JUMP_VELOCITY;
    } else if (platformUnderfoot(state, map)) {
      // Nudge the feet just below the top edge so the one-way check lets us fall.
      y0 += PLATFORM_DROP_NUDGE;
    }
  }
  vy = Math.min(vy + GRAVITY * DT, MAX_FALL_SPEED);

  const x = moveHorizontally(state.x, y0, vx, map);
  const fall = moveVertically(x, y0, vy, map);
  const { y, vy: vyOut, onGround } = landOnPlatforms(x, y0 + PLAYER_HALF_H, fall, map);

  return { x, y, vx, vy: vyOut, facing, onGround, rope: -1 };
}

/**
 * Advance one player by a single fixed tick. Pure: returns a fresh state and
 * never mutates its arguments, so identical inputs always yield identical output.
 */
export function stepPlayer(state: PlayerState, input: PlayerInput, map: CollisionMap): PlayerState {
  const rope = state.rope >= 0 ? map.ropes[state.rope] : undefined;
  if (rope) {
    if (!(input.jump && (input.left || input.right))) return climbRope(state, input, rope);
    // Jumping off needs a direction (plain jump keeps climbing). Fall through
    // to the regular step so the horizontal input takes effect this tick.
    state = { ...state, rope: -1, vy: ROPE_JUMP_VELOCITY, onGround: false };
  } else if (input.up || input.down) {
    const grabbed = grabRope(state, input, map);
    if (grabbed >= 0) return snapToRope(state, map.ropes[grabbed], grabbed);
  }
  return stepFreeMovement(state, input, map);
}
