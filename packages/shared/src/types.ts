/** Direction the player sprite faces. */
export type Facing = -1 | 1;

/** Player intent for one simulation tick. */
export interface PlayerInput {
  left: boolean;
  right: boolean;
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
}

/** Axis-aligned rectangle: top-left corner plus size, in world pixels. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Static collision geometry of a map. All solids are impassable AABBs. */
export interface CollisionMap {
  width: number;
  height: number;
  solids: Rect[];
}
