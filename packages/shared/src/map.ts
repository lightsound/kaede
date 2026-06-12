import { PLAYER_HALF_H } from './constants';
import type { CollisionMap } from './types';

export const WORLD_WIDTH = 3840;
export const WORLD_HEIGHT = 720;

/** y coordinate of the walkable ground surface. */
export const GROUND_TOP = 656;

/** Where new players appear (AABB center). */
export const SPAWN_X = 200;
export const SPAWN_Y = GROUND_TOP - PLAYER_HALF_H;

/** AABB-center y of a player standing on the ground. Portal centers and ground
 *  landing spots use this so a grounded player's center lines up with them. */
const GROUNDED_Y = GROUND_TOP - PLAYER_HALF_H;

/**
 * Map 0 — はじまりの草原 ("Plains of Beginning"). The original world, geometry
 * unchanged: the ground slab is the only solid; every floating platform is
 * one-way (jump through from below, land from above, drop through with
 * down+jump). Platform tops sit 100-120px apart so each is reachable with the
 * standard jump (max jump height ~147px) — except the high platform at y=300,
 * which is reachable only by climbing its rope.
 *
 * Rope `bottom` is the lowest CENTER y while climbing: floorTop minus
 * PLAYER_HALF_H of whatever the rope's lower end rests on.
 *
 * A portal sits on the ground near the right edge (x=3700) and sends the player
 * to map 1. Its landing target (see くらやみの森 below) is offset from map 1's
 * return portal so a held up key can't bounce the player straight back.
 */
const PLAINS: CollisionMap = {
  name: 'はじまりの草原',
  width: WORLD_WIDTH,
  height: WORLD_HEIGHT,
  solids: [{ x: 0, y: GROUND_TOP, w: WORLD_WIDTH, h: WORLD_HEIGHT - GROUND_TOP }],
  platforms: [
    { x: 420, y: 540, w: 260, h: 24 },
    { x: 860, y: 440, w: 260, h: 24 },
    { x: 1320, y: 540, w: 300, h: 24 },
    { x: 1300, y: 300, w: 200, h: 24 },
    { x: 1800, y: 430, w: 240, h: 24 },
    { x: 2240, y: 540, w: 320, h: 24 },
    { x: 2760, y: 450, w: 260, h: 24 },
    { x: 3260, y: 540, w: 280, h: 24 },
  ],
  ropes: [
    { x: 550, top: 540, bottom: GROUND_TOP - PLAYER_HALF_H }, // ground → platform at 420
    { x: 990, top: 440, bottom: GROUND_TOP - PLAYER_HALF_H }, // ground → platform at 860
    { x: 1400, top: 300, bottom: 540 - PLAYER_HALF_H }, // platform at 1320 → high platform
  ],
  portals: [
    // Right-edge portal → map 1's left side, landing offset from map 1's portal.
    { x: 3700, y: GROUNDED_Y, targetMap: 1, targetX: 230, targetY: GROUNDED_Y },
  ],
};

/**
 * Map 1 — くらやみの森 ("Forest of Darkness"). A NEW map with the SAME width and
 * height as map 0 (3840x720). Keeping the dimensions identical is deliberate:
 * the camera clamp (cameraOffset) and the parallax backdrop are sized to the
 * world, so an equal-sized second map needs ZERO changes to either — only the
 * foreground geometry container is swapped.
 *
 * Distinct layout: denser platform stacks (two vertical towers on the left and
 * right), three ropes, and a couple of high ledges that ropes reach. A portal
 * near the left edge (x=150) returns to map 0, landing offset from map 0's
 * portal (3700) so a held up key can't ping-pong the player.
 */
const FOREST: CollisionMap = {
  name: 'くらやみの森',
  width: WORLD_WIDTH,
  height: WORLD_HEIGHT,
  solids: [{ x: 0, y: GROUND_TOP, w: WORLD_WIDTH, h: WORLD_HEIGHT - GROUND_TOP }],
  platforms: [
    // Left stair-stack tower rising to a high ledge.
    { x: 360, y: 560, w: 220, h: 24 },
    { x: 620, y: 460, w: 200, h: 24 },
    { x: 640, y: 360, w: 200, h: 24 }, // high ledge (rope-reachable; overlaps the 620 platform)
    // Central cluster of stacked platforms.
    { x: 1100, y: 540, w: 240, h: 24 },
    { x: 1420, y: 440, w: 220, h: 24 },
    { x: 1440, y: 340, w: 200, h: 24 }, // high ledge (rope-reachable; overlaps the 1420 platform)
    { x: 1760, y: 540, w: 260, h: 24 },
    // Right stair-stack tower.
    { x: 2300, y: 560, w: 220, h: 24 },
    { x: 2560, y: 460, w: 200, h: 24 },
    { x: 2580, y: 360, w: 200, h: 24 }, // high ledge (rope-reachable; overlaps the 2560 platform)
    { x: 3200, y: 540, w: 280, h: 24 },
  ],
  // Each rope's x lies within BOTH its lower platform and its upper ledge, so a
  // top-exit climb steps the player onto solid ground (not into thin air).
  ropes: [
    // Left tower: platform {620..820} (top 460) up to ledge {640..840} (top 360).
    { x: 700, top: 360, bottom: 460 - PLAYER_HALF_H },
    // Central: platform {1420..1640} (top 440) up to ledge {1440..1640} (top 340).
    { x: 1520, top: 340, bottom: 440 - PLAYER_HALF_H },
    // Right tower: platform {2560..2760} (top 460) up to ledge {2580..2780} (top 360).
    { x: 2660, top: 360, bottom: 460 - PLAYER_HALF_H },
  ],
  portals: [
    // Left-edge portal → map 0's right side, landing offset from map 0's portal.
    { x: 150, y: GROUNDED_Y, targetMap: 0, targetX: 3620, targetY: GROUNDED_Y },
  ],
};

/**
 * Every map, indexed by PlayerState.mapId. The deterministic step picks
 * `maps[state.mapId]` each tick, so this single source of truth is shared by the
 * server replay, client prediction, and rendering.
 */
export const MAPS: readonly CollisionMap[] = [PLAINS, FOREST];

/**
 * Back-compat alias for the starting map. New code should index MAPS by
 * PlayerState.mapId instead; this kept so a few single-map call sites/tests can
 * keep referring to "the default map" without reaching into MAPS[0].
 */
export const DEFAULT_MAP: CollisionMap = MAPS[0];
