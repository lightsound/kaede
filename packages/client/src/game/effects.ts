import {
  ATTACK_HALF_H,
  ATTACK_RANGE_X,
  PLAYER_HALF_H,
  type Facing,
  type MobKind,
} from '@maple/shared';
import { Container, Graphics, Text, TextStyle } from 'pixi.js';
import { NORD_RED, NORD_YELLOW } from './colors';
import { createDeathPoof } from './sprites/mobs';

// --- Effect style / timing constants ---
const SLASH_COLOR = 0xeceff4;
const SLASH_FADE_MS = 100;
const DAMAGE_RISE_PX = 40; // how far a damage number floats up over its life
const DAMAGE_LIFE_MS = 800;
const LEVELUP_LIFE_MS = 900;
const MAP_TOAST_LIFE_MS = 1600;

// Damage-number colors by kind. Mob hits read as plain white; own-damage reuses
// the HP red; XP gains use the aurora green and the "+N EXP" wording below.
const DAMAGE_WHITE = 0xffffff;
const EXP_GREEN = 0xa3be8c;
/** Floating combat text: which feedback a number conveys (drives color + format). */
export type DamageKind = 'mob' | 'own' | 'exp';
const DAMAGE_COLORS: Record<DamageKind, number> = {
  mob: DAMAGE_WHITE,
  own: NORD_RED,
  exp: EXP_GREEN,
};

const LEVELUP_STYLE = new TextStyle({ fill: NORD_YELLOW, fontSize: 22, fontFamily: 'sans-serif' });
// Screen-centered map-name toast on a map change; fades like the LEVEL UP flash.
const MAP_TOAST_STYLE = new TextStyle({ fill: 0xeceff4, fontSize: 28, fontFamily: 'sans-serif' });

/** A render-only effect with a finite lifetime; `update` returns false when done. */
interface Effect {
  node: Container;
  update(dtMs: number): boolean;
}

export interface Effects {
  /** World-space transient layer (slashes, damage numbers, poofs). Add inside the world. */
  worldLayer: Container;
  /** Screen-space transient layer (the map-name toast). Add to the stage. */
  screenLayer: Container;
  /** Spawn a short fading slash arc in front of (x, y) facing `facing`. */
  spawnSlash(x: number, y: number, facing: Facing): void;
  /** Floating combat text that rises and fades at world position (x, y). */
  spawnDamageNumber(x: number, y: number, amount: number, kind: DamageKind): void;
  /** An expanding fading poof at a mob's death spot. */
  spawnDeathPoof(x: number, y: number, kind: MobKind): void;
  /** A floating "LEVEL UP!" flash above (x, y). */
  spawnLevelUp(x: number, y: number): void;
  /** A centered map-name toast that fades over its life, like LEVEL UP. */
  spawnMapToast(name: string, viewW: number, viewH: number): void;
  /** Advance and reap both effect lists by dtMs. */
  update(dtMs: number): void;
  /** Drop all WORLD-space effects (used on map switch; their spots are meaningless on the new map). */
  clearWorld(): void;
}

/**
 * The transient-effects subsystem: owns the world- and screen-space effect
 * layers and the lifetime bookkeeping for slashes, damage numbers, death poofs,
 * the level-up flash, and the map toast. GameApp adds the two layers at the
 * right depth and ticks `update`; the spawn helpers below all funnel through
 * `pushTimed`, which owns the advance/reap scaffold so each spawn only describes
 * its per-frame look via an `onProgress(k)` callback (k = ms/life in 0..1).
 */
export function createEffects(): Effects {
  // World-space transient effects (slashes, damage numbers) drawn above players.
  const worldLayer = new Container();
  const world: Effect[] = [];
  // Screen-space transient effects (the map-name toast): parented to the stage
  // so they stay centered regardless of camera. Advanced by the same loop.
  const screenLayer = new Container();
  const screen: Effect[] = [];

  /**
   * Register a node on `layer`/`list` for `lifeMs`, calling `onProgress(k)` each
   * frame with k = elapsed/life in [0, 1) until it expires. Owns the shared
   * `ms += dt; k = ms/life; reap` scaffold so each spawn only writes its look.
   */
  function pushTimed(
    layer: Container,
    list: Effect[],
    node: Container,
    lifeMs: number,
    onProgress: (k: number) => void,
  ): void {
    layer.addChild(node);
    let ms = 0;
    list.push({
      node,
      update(dtMs) {
        ms += dtMs;
        onProgress(ms / lifeMs);
        return ms < lifeMs;
      },
    });
  }

  function spawnSlash(x: number, y: number, facing: Facing): void {
    // A thin rect spanning the attack reach in front of the player center.
    const g = new Graphics()
      .rect(0, -ATTACK_HALF_H, ATTACK_RANGE_X, ATTACK_HALF_H * 2)
      .fill({ color: SLASH_COLOR, alpha: 0.5 });
    g.position.set(x, y);
    g.scale.x = facing; // mirror so it draws in front when facing left
    pushTimed(worldLayer, world, g, SLASH_FADE_MS, (k) => {
      g.alpha = Math.max(0, 1 - k);
    });
  }

  function spawnDamageNumber(x: number, y: number, amount: number, kind: DamageKind): void {
    // The green convention is reserved for XP, which reads as "+N EXP"; every
    // other kind is a hit and reads as the bare number.
    const text = kind === 'exp' ? `+${amount} EXP` : `${amount}`;
    const t = new Text({
      text,
      style: new TextStyle({ fill: DAMAGE_COLORS[kind], fontSize: 16, fontFamily: 'sans-serif' }),
    });
    t.anchor.set(0.5, 1);
    t.position.set(x, y);
    pushTimed(worldLayer, world, t, DAMAGE_LIFE_MS, (k) => {
      t.position.set(x, y - DAMAGE_RISE_PX * k);
      t.alpha = Math.max(0, 1 - k);
    });
  }

  function spawnDeathPoof(x: number, y: number, kind: MobKind): void {
    const poof = createDeathPoof(kind);
    poof.node.position.set(x, y);
    worldLayer.addChild(poof.node);
    // createDeathPoof owns its own ms/life scaffold (it redraws the ring), so it
    // rides the list directly rather than through pushTimed.
    world.push({ node: poof.node, update: poof.update });
  }

  function spawnLevelUp(x: number, y: number): void {
    const t = new Text({ text: 'LEVEL UP!', style: LEVELUP_STYLE });
    t.anchor.set(0.5, 1);
    const baseY = y - PLAYER_HALF_H - 16;
    t.position.set(x, baseY);
    pushTimed(worldLayer, world, t, LEVELUP_LIFE_MS, (k) => {
      t.position.set(x, baseY - DAMAGE_RISE_PX * k);
      t.alpha = Math.max(0, 1 - k);
    });
  }

  function spawnMapToast(name: string, viewW: number, viewH: number): void {
    const t = new Text({ text: name, style: MAP_TOAST_STYLE });
    t.anchor.set(0.5, 0.5);
    t.position.set(viewW / 2, viewH * 0.3);
    pushTimed(screenLayer, screen, t, MAP_TOAST_LIFE_MS, (k) => {
      // Hold full opacity for the first third, then fade out.
      t.alpha = k < 0.33 ? 1 : Math.max(0, 1 - (k - 0.33) / 0.67);
    });
  }

  /** Advance and reap one list, destroying finished nodes. */
  function advance(list: Effect[], dtMs: number): void {
    for (let i = list.length - 1; i >= 0; i--) {
      if (!list[i].update(dtMs)) {
        list[i].node.destroy({ children: true });
        list.splice(i, 1);
      }
    }
  }

  function update(dtMs: number): void {
    advance(world, dtMs);
    advance(screen, dtMs);
  }

  function clearWorld(): void {
    for (const e of world) e.node.destroy({ children: true });
    world.length = 0;
  }

  return {
    worldLayer,
    screenLayer,
    spawnSlash,
    spawnDamageNumber,
    spawnDeathPoof,
    spawnLevelUp,
    spawnMapToast,
    update,
    clearWorld,
  };
}
