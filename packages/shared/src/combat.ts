import { type AABB } from './physics';
import type { PlayerState } from './types';

/**
 * How long (in ticks) a swing locks out the next one. Long enough that holding
 * the attack key produces a steady cadence rather than every-frame swings.
 */
export const ATTACK_COOLDOWN_TICKS = 36;

/**
 * Melee hitbox: reaches ATTACK_RANGE_X px in front of the player's center, with
 * a vertical half-extent of ATTACK_HALF_H. Tuned so a swing connects with a mob
 * the player is standing next to without hitting things a screen away.
 */
export const ATTACK_RANGE_X = 70;
export const ATTACK_HALF_H = 28;

/** Mob AI cadence: the scheduled reducer fires every MOB_TICK_MS ms (10 Hz). */
export const MOB_TICK_MS = 100;
/** A slain mob respawns this long after death. */
export const MOB_RESPAWN_MS = 5000;
/** After taking contact damage a player is invulnerable for this long. */
export const PLAYER_INVULN_MS = 1000;

/** Melee damage a player deals per hit, scaling with level. */
export function attackDamage(level: number): number {
  return 8 + 2 * level;
}

/** Max HP at a given level. Level 1 = 50, +10 per level thereafter. */
export function maxHpForLevel(level: number): number {
  return 50 + 10 * (level - 1);
}

/**
 * XP required to advance FROM `level` to the next. XP is tracked per-level and
 * the remainder carries over on level-up, so the curve only needs the cost of
 * the current level.
 */
export function xpToNext(level: number): number {
  return 25 * level * level;
}

/**
 * The swing hitbox for `state`: a box extending ATTACK_RANGE_X in the facing
 * direction from the player center, so its center sits half a range ahead.
 */
export function attackHitbox(state: PlayerState): AABB {
  return {
    cx: state.x + (state.facing * ATTACK_RANGE_X) / 2,
    cy: state.y,
    hw: ATTACK_RANGE_X / 2,
    hh: ATTACK_HALF_H,
  };
}
