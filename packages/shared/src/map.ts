import { PLAYER_HALF_H } from './constants';
import type { CollisionMap } from './types';

export const WORLD_WIDTH = 3840;
export const WORLD_HEIGHT = 720;

/** y coordinate of the walkable ground surface. */
export const GROUND_TOP = 656;

/** Where new players appear (AABB center). */
export const SPAWN_X = 200;
export const SPAWN_Y = GROUND_TOP - PLAYER_HALF_H;

/**
 * The single hard-coded level: a full-width ground slab plus a handful of
 * floating platforms. Platform tops sit 100-120px apart so every one of them
 * is reachable with the standard jump (max jump height ~147px).
 */
export const DEFAULT_MAP: CollisionMap = {
  width: WORLD_WIDTH,
  height: WORLD_HEIGHT,
  solids: [
    { x: 0, y: GROUND_TOP, w: WORLD_WIDTH, h: WORLD_HEIGHT - GROUND_TOP },
    { x: 420, y: 540, w: 260, h: 24 },
    { x: 860, y: 440, w: 260, h: 24 },
    { x: 1320, y: 540, w: 300, h: 24 },
    { x: 1800, y: 430, w: 240, h: 24 },
    { x: 2240, y: 540, w: 320, h: 24 },
    { x: 2760, y: 450, w: 260, h: 24 },
    { x: 3260, y: 540, w: 280, h: 24 },
  ],
};
