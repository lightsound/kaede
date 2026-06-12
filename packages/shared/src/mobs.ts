import { GROUND_TOP } from './map';
import { type AABB, overlaps } from './physics';
import { attackHitbox } from './combat';
import type { PlayerState } from './types';

/** The mob species in the world. Stored as a string column on the mob row. */
export type MobKind = 'slime' | 'mushroom';

/** Static, per-kind balance numbers. Half extents define the mob's AABB. */
export interface MobStats {
  maxHp: number;
  /** Damage dealt to a player on contact. */
  touchDamage: number;
  /** XP awarded when slain. */
  xp: number;
  /** Patrol speed in px/s. */
  speed: number;
  halfW: number;
  halfH: number;
}

export const MOB_STATS: Record<MobKind, MobStats> = {
  slime: { maxHp: 40, touchDamage: 8, xp: 12, speed: 60, halfW: 14, halfH: 12 },
  mushroom: { maxHp: 90, touchDamage: 15, xp: 30, speed: 85, halfW: 16, halfH: 16 },
};

/**
 * A spawn point. `x` is the initial center; the mob patrols horizontally
 * between minX and maxX (clamped to the supporting surface). `y` is the center
 * y where the mob rests on its surface (surfaceTop - halfH).
 */
export interface MobSpawn {
  kind: MobKind;
  x: number;
  y: number;
  minX: number;
  maxX: number;
}

const slimeY = GROUND_TOP - MOB_STATS.slime.halfH;
const groundMushroomY = GROUND_TOP - MOB_STATS.mushroom.halfH;
/** Mushroom resting y for a one-way platform whose top is at `platTop`. */
const platMushroomY = (platTop: number) => platTop - MOB_STATS.mushroom.halfH;

/**
 * Hand-placed spawns sitting on DEFAULT_MAP geometry. Slimes patrol the ground
 * in two clusters; mushrooms guard the right-side one-way platforms (tops at
 * y=540/450/540 for x 2240/2760/3260) plus one on the ground. Patrol ranges are
 * kept inside each supporting surface so a mob never walks off its platform.
 */
export const MOB_SPAWNS: MobSpawn[] = [
  // Ground slimes (left cluster, x ~600-1100).
  { kind: 'slime', x: 640, y: slimeY, minX: 600, maxX: 820 },
  { kind: 'slime', x: 980, y: slimeY, minX: 880, maxX: 1100 },
  // Ground slimes (right cluster, x ~1500-2000).
  { kind: 'slime', x: 1560, y: slimeY, minX: 1500, maxX: 1740 },
  { kind: 'slime', x: 1900, y: slimeY, minX: 1780, maxX: 2000 },
  // Mushrooms on the one-way platforms. Platform 5 {2240,540,w320}: x 2240..2560.
  { kind: 'mushroom', x: 2380, y: platMushroomY(540), minX: 2270, maxX: 2530 },
  // Platform 6 {2760,450,w260}: x 2760..3020.
  { kind: 'mushroom', x: 2880, y: platMushroomY(450), minX: 2790, maxX: 2990 },
  // Platform 7 {3260,540,w280}: x 3260..3540.
  { kind: 'mushroom', x: 3400, y: platMushroomY(540), minX: 3290, maxX: 3510 },
  // One mushroom patrolling the ground around x 2400-3000.
  { kind: 'mushroom', x: 2700, y: groundMushroomY, minX: 2400, maxX: 3000 },
];

/**
 * Advance one mob's horizontal patrol by dtMs. Walks dir * speed; on reaching a
 * bound it clamps to that bound and reverses direction, so the mob bounces
 * between minX and maxX forever. Pure: returns the next { x, dir }.
 */
export function stepMobPatrol(
  x: number,
  dir: number,
  spawn: { kind: MobKind; minX: number; maxX: number },
  dtMs: number,
): { x: number; dir: number } {
  const speed = MOB_STATS[spawn.kind].speed;
  let nx = x + dir * speed * (dtMs / 1000);
  let nd = dir;
  if (nx <= spawn.minX) {
    nx = spawn.minX;
    nd = 1;
  } else if (nx >= spawn.maxX) {
    nx = spawn.maxX;
    nd = -1;
  }
  return { x: nx, dir: nd };
}

/** A mob's AABB from its rendered position and kind. */
export function mobBox(x: number, y: number, kind: MobKind): AABB {
  const s = MOB_STATS[kind];
  return { cx: x, cy: y, hw: s.halfW, hh: s.halfH };
}

/**
 * Index of the nearest alive mob (by |dx| to the player) whose AABB overlaps the
 * player's attack hitbox, or -1 if none. One swing hits at most one target.
 */
export function resolveAttackTarget(
  state: PlayerState,
  mobs: { x: number; y: number; kind: MobKind; alive: boolean }[],
): number {
  const hit = attackHitbox(state);
  // The hitbox is an AABB; overlaps() takes a Rect, so express it as one.
  const hitRect = { x: hit.cx - hit.hw, y: hit.cy - hit.hh, w: hit.hw * 2, h: hit.hh * 2 };
  let best = -1;
  let bestDx = Infinity;
  for (let i = 0; i < mobs.length; i++) {
    const m = mobs[i];
    if (!m.alive) continue;
    if (!overlaps(mobBox(m.x, m.y, m.kind), hitRect)) continue;
    const dx = Math.abs(m.x - state.x);
    if (dx < bestDx) {
      bestDx = dx;
      best = i;
    }
  }
  return best;
}
