/** Direction the player sprite faces. */
export type Facing = -1 | 1;

/** Player intent for one simulation tick. */
export interface PlayerInput {
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  jump: boolean;
  attack: boolean;
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
  /** Index into the map's ropes while climbing, or -1 when not climbing. */
  rope: number;
  /**
   * Ticks remaining before the next attack can fire (0 = ready). Decrements one
   * per tick in stepPlayer; set to ATTACK_COOLDOWN_TICKS on the tick a swing
   * fires. Part of PlayerState so prediction and server replay stay in lockstep.
   */
  attackCooldown: number;
}

/** Axis-aligned rectangle: top-left corner plus size, in world pixels. */
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

/** Static collision geometry of a map. */
export interface CollisionMap {
  width: number;
  height: number;
  /** Impassable AABBs (ground, walls). Block movement from every side. */
  solids: Rect[];
  /** One-way platforms: support the player only when falling onto their top edge. */
  platforms: Rect[];
  ropes: Rope[];
}
