export type Facing = -1 | 1;

export interface PlayerInput {
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  jump: boolean;
}

/**
 * Full dynamic state of a player. (x, y) is the center of the player AABB
 * (half extents PLAYER_HALF_W / PLAYER_HALF_H), in world pixels, y-down.
 */
export interface PlayerState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  facing: Facing;
  onGround: boolean;
  rope: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A climbable vertical line (rope/ladder). `top` and `bottom` bound the
 * player's CENTER y while climbing. A rope whose lower end rests on a floor
 * should use bottom = floorTop - PLAYER_HALF_H, so letting go at the bottom
 * lands instantly instead of clipping into the floor.
 */
export interface Rope {
  x: number;
  top: number;
  bottom: number;
}

export interface CollisionMap {
  width: number;
  height: number;
  solids: Rect[];
  platforms: Rect[];
  ropes: Rope[];
}
