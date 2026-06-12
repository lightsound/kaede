import { describe, expect, it } from 'vitest';
import {
  ATTACK_COOLDOWN_TICKS,
  ATTACK_HALF_H,
  ATTACK_RANGE_X,
  DEFAULT_MAP,
  GROUND_TOP,
  MAPS,
  MOB_STATS,
  MOB_SPAWNS,
  PLAYER_HALF_H,
  SPAWN_X,
  attackDamage,
  attackFires,
  attackHitbox,
  maxHpForLevel,
  resolveAttackTarget,
  stepMobPatrol,
  stepPlayer,
  xpToNext,
  type MobKind,
  type PlayerInput,
  type PlayerState,
} from '../src/index';

const NO_INPUT: PlayerInput = { left: false, right: false, jump: false, up: false, down: false, attack: false };
const ATTACK: PlayerInput = { ...NO_INPUT, attack: true };

const GROUNDED_Y = GROUND_TOP - PLAYER_HALF_H;

// Single-map MAPS list for stepPlayer (the player's mapId is 0, so maps[0]).
const MAPS0 = [DEFAULT_MAP];

function spawn(overrides: Partial<PlayerState> = {}): PlayerState {
  return { x: SPAWN_X, y: GROUNDED_Y, vx: 0, vy: 0, facing: 1, onGround: true, rope: -1, attackCooldown: 0, mapId: 0, ...overrides };
}

describe('attack cooldown lifecycle in stepPlayer', () => {
  it('fires when ready and latches the full cooldown on the post-step state', () => {
    const before = spawn();
    expect(attackFires(before, ATTACK)).toBe(true);
    const after = stepPlayer(before, ATTACK, MAPS0);
    expect(after.attackCooldown).toBe(ATTACK_COOLDOWN_TICKS);
  });

  it('blocks a re-fire while the cooldown is above 0, then re-fires at 0', () => {
    let s = stepPlayer(spawn(), ATTACK, MAPS0);
    expect(s.attackCooldown).toBe(ATTACK_COOLDOWN_TICKS);
    // Hold attack: every intermediate tick is blocked and decrements by one. It
    // takes ATTACK_COOLDOWN_TICKS more steps to drain 36 -> 0.
    for (let i = 0; i < ATTACK_COOLDOWN_TICKS; i++) {
      const cd = s.attackCooldown;
      expect(attackFires(s, ATTACK)).toBe(false);
      s = stepPlayer(s, ATTACK, MAPS0);
      expect(s.attackCooldown).toBe(cd - 1);
    }
    // Now cooldown is exactly 0 and the next swing fires again.
    expect(s.attackCooldown).toBe(0);
    expect(attackFires(s, ATTACK)).toBe(true);
    const refired = stepPlayer(s, ATTACK, MAPS0);
    expect(refired.attackCooldown).toBe(ATTACK_COOLDOWN_TICKS);
  });

  it('does not fire while climbing, but still decrements the cooldown', () => {
    // On a rope with a partial cooldown: attack is suppressed yet the clock ticks.
    const onRope = spawn({ x: 550, y: 580, onGround: false, rope: 0, attackCooldown: 5 });
    expect(attackFires(onRope, ATTACK)).toBe(false);
    const after = stepPlayer(onRope, { ...ATTACK, up: true }, MAPS0);
    expect(after.rope).toBe(0); // still climbing
    expect(after.attackCooldown).toBe(4); // decremented, not latched
  });

  it('decays to 0 with no attack input held', () => {
    let s = stepPlayer(spawn(), ATTACK, MAPS0);
    for (let i = 0; i < ATTACK_COOLDOWN_TICKS; i++) s = stepPlayer(s, NO_INPUT, MAPS0);
    expect(s.attackCooldown).toBe(0);
  });
});

describe('attackHitbox', () => {
  it('extends in front of the player when facing right', () => {
    const box = attackHitbox(spawn({ facing: 1, x: 100, y: 200 }));
    expect(box.cx).toBe(100 + ATTACK_RANGE_X / 2);
    expect(box.cy).toBe(200);
    expect(box.hw).toBe(ATTACK_RANGE_X / 2);
    expect(box.hh).toBe(ATTACK_HALF_H);
    // Reaches ATTACK_RANGE_X to the right, but not behind the player center.
    expect(box.cx + box.hw).toBe(100 + ATTACK_RANGE_X);
    expect(box.cx - box.hw).toBe(100);
  });

  it('extends in front of the player when facing left (mirror image)', () => {
    const box = attackHitbox(spawn({ facing: -1, x: 100, y: 200 }));
    expect(box.cx).toBe(100 - ATTACK_RANGE_X / 2);
    expect(box.cx - box.hw).toBe(100 - ATTACK_RANGE_X);
    expect(box.cx + box.hw).toBe(100);
  });
});

describe('resolveAttackTarget', () => {
  const player = spawn({ x: 100, y: 200, facing: 1 });

  it('returns the nearest alive overlapping mob', () => {
    const mobs = [
      { x: 160, y: 200, kind: 'slime' as MobKind, alive: true }, // farther, in range
      { x: 120, y: 200, kind: 'slime' as MobKind, alive: true }, // nearer
    ];
    expect(resolveAttackTarget(player, mobs)).toBe(1);
  });

  it('returns -1 when the only mob is out of range', () => {
    const mobs = [{ x: 100 + ATTACK_RANGE_X + 50, y: 200, kind: 'slime' as MobKind, alive: true }];
    expect(resolveAttackTarget(player, mobs)).toBe(-1);
  });

  it('ignores a mob behind the player (wrong facing)', () => {
    const mobs = [{ x: 60, y: 200, kind: 'slime' as MobKind, alive: true }];
    expect(resolveAttackTarget(player, mobs)).toBe(-1);
  });

  it('filters out dead mobs even when in range', () => {
    const mobs = [
      { x: 120, y: 200, kind: 'slime' as MobKind, alive: false },
      { x: 150, y: 200, kind: 'slime' as MobKind, alive: true },
    ];
    expect(resolveAttackTarget(player, mobs)).toBe(1);
  });

  it('rejects a mob outside the vertical half-extent', () => {
    const mobs = [{ x: 120, y: 200 + ATTACK_HALF_H + MOB_STATS.slime.halfH + 10, kind: 'slime' as MobKind, alive: true }];
    expect(resolveAttackTarget(player, mobs)).toBe(-1);
  });
});

describe('stepMobPatrol', () => {
  const spawn0 = { kind: 'slime' as MobKind, minX: 600, maxX: 800 };

  it('walks in the current direction within bounds', () => {
    const r = stepMobPatrol(700, 1, spawn0, 100);
    expect(r.dir).toBe(1);
    expect(r.x).toBeCloseTo(700 + MOB_STATS.slime.speed * 0.1);
  });

  it('clamps to maxX and reverses at the right bound', () => {
    const r = stepMobPatrol(795, 1, spawn0, 1000);
    expect(r.x).toBe(800);
    expect(r.dir).toBe(-1);
  });

  it('clamps to minX and reverses at the left bound', () => {
    const r = stepMobPatrol(605, -1, spawn0, 1000);
    expect(r.x).toBe(600);
    expect(r.dir).toBe(1);
  });
});

describe('xp / level helpers', () => {
  it('scales damage and max HP with level', () => {
    expect(attackDamage(1)).toBe(10);
    expect(attackDamage(5)).toBe(18);
    expect(maxHpForLevel(1)).toBe(50);
    expect(maxHpForLevel(3)).toBe(70);
  });

  it('grows the xp-to-next curve quadratically', () => {
    expect(xpToNext(1)).toBe(25);
    expect(xpToNext(2)).toBe(100);
    expect(xpToNext(3)).toBe(225);
  });
});

describe('MOB_SPAWNS placement', () => {
  it('keeps every patrol range inside its [minX, maxX] and on a valid surface of its map', () => {
    for (const s of MOB_SPAWNS) {
      expect(s.minX).toBeLessThan(s.maxX);
      expect(s.x).toBeGreaterThanOrEqual(s.minX);
      expect(s.x).toBeLessThanOrEqual(s.maxX);
      // A spawn's map must exist; its surface is checked against THAT map.
      expect(s.map).toBeGreaterThanOrEqual(0);
      expect(s.map).toBeLessThan(MAPS.length);
      // y is a resting center: surfaceTop = y + halfH should match a surface.
      const halfH = MOB_STATS[s.kind].halfH;
      const surfaceTop = s.y + halfH;
      const onGround = surfaceTop === GROUND_TOP;
      const onPlatform = MAPS[s.map].platforms.some(
        (p) => p.y === surfaceTop && s.minX >= p.x && s.maxX <= p.x + p.w,
      );
      expect(onGround || onPlatform).toBe(true);
    }
  });
});
