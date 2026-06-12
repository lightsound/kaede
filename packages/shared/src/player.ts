import {
  DT,
  GRAVITY,
  JUMP_VELOCITY,
  MAX_FALL_SPEED,
  MOVE_SPEED,
  PLAYER_HALF_H,
  PLAYER_HALF_W,
} from './constants';
import { overlaps, rectBounds, type AABB } from './physics';
import type { CollisionMap, Facing, PlayerInput, PlayerState } from './types';

function box(x: number, y: number): AABB {
  return { cx: x, cy: y, hw: PLAYER_HALF_W, hh: PLAYER_HALF_H };
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
}): PlayerState {
  return {
    x: r.x,
    y: r.y,
    vx: r.vx,
    vy: r.vy,
    facing: toFacing(r.facing),
    onGround: r.onGround,
  };
}

/**
 * Advance one player by a single fixed tick. Pure: returns a fresh state and
 * never mutates its arguments, so identical inputs always yield identical output.
 */
export function stepPlayer(state: PlayerState, input: PlayerInput, map: CollisionMap): PlayerState {
  const vx = ((input.right ? 1 : 0) - (input.left ? 1 : 0)) * MOVE_SPEED;
  let facing: Facing = state.facing;
  if (vx > 0) facing = 1;
  else if (vx < 0) facing = -1;

  let vy = state.vy;
  if (input.jump && state.onGround) vy = JUMP_VELOCITY;
  vy = Math.min(vy + GRAVITY * DT, MAX_FALL_SPEED);

  // Horizontal move + resolution. Walls only stop you; vx is unchanged.
  let x = state.x + vx * DT;
  for (const solid of map.solids) {
    if (!overlaps(box(x, state.y), solid)) continue;
    const s = rectBounds(solid);
    if (vx > 0) x = s.left - PLAYER_HALF_W;
    else if (vx < 0) x = s.right + PLAYER_HALF_W;
  }
  x = Math.min(Math.max(x, PLAYER_HALF_W), map.width - PLAYER_HALF_W);

  // Vertical move + resolution. A downward hit lands us; either hit zeroes vy.
  let y = state.y + vy * DT;
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

  return { x, y, vx, vy, facing, onGround };
}
