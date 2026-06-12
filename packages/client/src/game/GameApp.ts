import {
  ATTACK_HALF_H,
  ATTACK_RANGE_X,
  DEFAULT_MAP,
  DT,
  MOB_STATS,
  PLAYER_HALF_H,
  PLAYER_HALF_W,
  SPAWN_X,
  SPAWN_Y,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  attackFires,
  packInput,
  stepPlayer,
  type Facing,
  type MobKind,
  type PlayerState,
} from '@maple/shared';
import { Application, Container, Graphics, Text, TextStyle } from 'pixi.js';
import { cameraOffset } from './camera';
import { createInput, mergeInputs } from './input';
import { correctionOffset, decayOffset, type Vec2 } from './smoothing';
import { createTouchControls } from './touchControls';

const VIEW_W = 1280;
const VIEW_H = 720;
const MAX_FRAME = 0.25;

const BG_COLOR = 0x10131b;
const SOLID_COLOR = 0x3b4252;
const PLATFORM_COLOR = 0x5e81ac; // one-way platforms: lighter than solid ground
const ROPE_COLOR = 0xd8a657;
const ROPE_WIDTH = 4;
const LOCAL_COLOR = 0x88c0d0;
const REMOTE_COLOR = 0xd08770;
const SLASH_COLOR = 0xeceff4;

// Mob rendering: rectangle sized per kind, plus an HP bar shown only when hurt.
const MOB_COLORS: Record<MobKind, number> = { slime: 0xa3be8c, mushroom: 0xd08770 };
const MOB_RENDER: Record<MobKind, { w: number; h: number }> = {
  slime: { w: 28, h: 24 },
  mushroom: { w: 32, h: 32 },
};
const HP_BAR_W = 36;
const HP_BAR_H = 4;
const HP_BAR_BG = 0x2e3440;
const HP_BAR_FG = 0xbf616a;

const SLASH_FADE_MS = 100;
const DAMAGE_RISE_PX = 40; // how far a damage number floats up over its life
const DAMAGE_LIFE_MS = 800;
const DEATH_FLASH_MS = 200;
const DEATH_FLASH_COLOR = 0xbf616a;

const DAMAGE_WHITE = 0xffffff;
const DAMAGE_RED = 0xbf616a;
const EXP_GREEN = 0xa3be8c;
const LEVELUP_GOLD = 0xebcb8b;

const NAME_STYLE = new TextStyle({ fill: 0xffffff, fontSize: 13, fontFamily: 'sans-serif' });
const HUD_STYLE = new TextStyle({ fill: 0xeceff4, fontSize: 14, fontFamily: 'sans-serif' });
const LEVELUP_STYLE = new TextStyle({ fill: LEVELUP_GOLD, fontSize: 22, fontFamily: 'sans-serif' });

export interface GameApp {
  destroy(): void;
  setLocalPlayerName(name: string): void;
  /**
   * Begin stepping the local simulation from `state` at `tick`. Until this is
   * called the ticker renders the scene but never steps physics or fires
   * onLocalTick, so the client waits for the authoritative spawn row.
   */
  start(state: PlayerState, tick: number): void;
  /**
   * Reconciliation hook: snap prev=curr=state and the tick counter to `tick`.
   * Rendering jumps to the corrected state (intended).
   */
  resetLocal(state: PlayerState, tick: number): void;
  onLocalTick(cb: (state: PlayerState, tick: number, packedInput: number) => void): void;
  onFrame(cb: (nowMs: number) => void): void;
  upsertRemotePlayer(id: string, name: string, x: number, y: number, facing: Facing): void;
  removeRemotePlayer(id: string): void;
  /** Upsert a mob view; hidden when hp <= 0. */
  upsertMob(id: number, kind: MobKind, x: number, y: number, dir: number, hp: number): void;
  removeMob(id: number): void;
  /** Floating combat text that rises and fades at world position (x, y). */
  spawnDamageNumber(x: number, y: number, amount: number, color: number): void;
  /** Update the fixed HUD bars (HP red, XP-to-next yellow) and the level label. */
  setHud(hp: number, maxHp: number, xp: number, xpToNext: number, level: number): void;
  /** Render a remote player's swing at that view's current position. */
  showRemoteSlash(idHex: string, facing: Facing): void;
  /** A floating "LEVEL UP!" flash at the local player on level change. */
  showLevelUp(): void;
  /** Brief full-screen red flash when own hp hits 0. */
  showDeathFlash(): void;
}

interface PlayerView {
  root: Container;
  body: Graphics;
  label: Text;
}

interface MobView {
  root: Container;
  body: Graphics;
  hpBar: Container;
  hpFill: Graphics;
  kind: MobKind;
}

/** A render-only effect with a finite lifetime; `update` returns false when done. */
interface Effect {
  node: Container;
  update(dtMs: number): boolean;
}

/** A labelled rectangle sprite parented under the world container. */
function createPlayerView(world: Container, name: string, color: number): PlayerView {
  const root = new Container();
  const body = new Graphics()
    .rect(-PLAYER_HALF_W, -PLAYER_HALF_H, PLAYER_HALF_W * 2, PLAYER_HALF_H * 2)
    .fill(color);
  const label = new Text({ text: name, style: NAME_STYLE });
  label.anchor.set(0.5, 1);
  label.y = -PLAYER_HALF_H - 4;
  root.addChild(body, label);
  world.addChild(root);
  return { root, body, label };
}

/** Damage-number colors are passed by callers; these are the conventions. */
export const DAMAGE_COLORS = {
  mob: DAMAGE_WHITE,
  own: DAMAGE_RED,
  exp: EXP_GREEN,
} as const;

export async function createGameApp(host: HTMLElement): Promise<GameApp> {
  const app = new Application();
  await app.init({ width: VIEW_W, height: VIEW_H, background: BG_COLOR, antialias: false });
  host.appendChild(app.canvas);

  const world = new Container();
  app.stage.addChild(world);

  // Static map geometry. Ropes hang behind everything; platforms and the
  // ground slab draw on top of them. All live in mapGfx, which is added to the
  // world before any player view, so the whole map renders behind players.
  const mapGfx = new Graphics();
  for (const r of DEFAULT_MAP.ropes) {
    // Visual span: rope.top down to rope.bottom + PLAYER_HALF_H (the lower end
    // rests on a floor, while rope.bottom bounds the climbing player's center).
    mapGfx
      .rect(r.x - ROPE_WIDTH / 2, r.top, ROPE_WIDTH, r.bottom + PLAYER_HALF_H - r.top)
      .fill(ROPE_COLOR);
  }
  for (const s of DEFAULT_MAP.solids) mapGfx.rect(s.x, s.y, s.w, s.h).fill(SOLID_COLOR);
  for (const p of DEFAULT_MAP.platforms) mapGfx.rect(p.x, p.y, p.w, p.h).fill(PLATFORM_COLOR);
  world.addChild(mapGfx);

  const mobs = new Map<number, MobView>();
  const local = createPlayerView(world, 'You', LOCAL_COLOR);
  const remotes = new Map<string, PlayerView>();

  // World-space transient effects (slashes, damage numbers) drawn above players.
  const effectsLayer = new Container();
  world.addChild(effectsLayer);
  const effects: Effect[] = [];

  // Screen-space overlay (HUD + death flash), added to the stage so it stays put.
  const hud = createHud();
  app.stage.addChild(hud.container);
  const deathFlash = new Graphics().rect(0, 0, VIEW_W, VIEW_H).fill(DEATH_FLASH_COLOR);
  deathFlash.alpha = 0;
  app.stage.addChild(deathFlash);
  let deathFlashMs = 0;

  const input = createInput();

  // Touch overlay: only built on coarse-pointer / touch-capable devices. Added
  // to app.stage (not world) so it stays fixed in screen space, above the world.
  const wantsTouch =
    window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
  const touch = wantsTouch ? createTouchControls() : undefined;
  if (touch) app.stage.addChild(touch.container);

  const tickCbs: ((s: PlayerState, tick: number, packedInput: number) => void)[] = [];
  const frameCbs: ((nowMs: number) => void)[] = [];

  let prev: PlayerState = {
    x: SPAWN_X, y: SPAWN_Y, vx: 0, vy: 0, facing: 1, onGround: false, rope: -1, attackCooldown: 0,
  };
  let curr: PlayerState = prev;
  let acc = 0;
  // Simulation is gated until start(): tick < 0 means "not yet running".
  let tick = -1;
  // Render-only smoothing for reconciliation corrections: the decaying error
  // between where we last rendered and the new corrected state. The simulation
  // state (prev/curr) always holds the exact corrected value; this offset only
  // shifts the sprite, never the physics.
  let localOffset: Vec2 = { x: 0, y: 0 };

  /** Spawn a short fading slash arc in front of (x, y) facing `facing`. */
  function spawnSlash(x: number, y: number, facing: Facing): void {
    // A thin rect spanning the attack reach in front of the player center.
    const g = new Graphics()
      .rect(0, -ATTACK_HALF_H, ATTACK_RANGE_X, ATTACK_HALF_H * 2)
      .fill({ color: SLASH_COLOR, alpha: 0.5 });
    g.position.set(x, y);
    g.scale.x = facing; // mirror so it draws in front when facing left
    effectsLayer.addChild(g);
    let ms = 0;
    effects.push({
      node: g,
      update(dtMs) {
        ms += dtMs;
        g.alpha = Math.max(0, 1 - ms / SLASH_FADE_MS);
        return ms < SLASH_FADE_MS;
      },
    });
  }

  function spawnDamageNumber(x: number, y: number, amount: number, color: number): void {
    // The green convention is reserved for XP, which reads as "+N EXP"; every
    // other color is a hit and reads as the bare number.
    const text = color === EXP_GREEN ? `+${amount} EXP` : `${amount}`;
    const t = new Text({ text, style: new TextStyle({ fill: color, fontSize: 16, fontFamily: 'sans-serif' }) });
    t.anchor.set(0.5, 1);
    t.position.set(x, y);
    effectsLayer.addChild(t);
    let ms = 0;
    effects.push({
      node: t,
      update(dtMs) {
        ms += dtMs;
        const k = ms / DAMAGE_LIFE_MS;
        t.position.set(x, y - DAMAGE_RISE_PX * k);
        t.alpha = Math.max(0, 1 - k);
        return ms < DAMAGE_LIFE_MS;
      },
    });
  }

  function spawnLevelUp(x: number, y: number): void {
    const t = new Text({ text: 'LEVEL UP!', style: LEVELUP_STYLE });
    t.anchor.set(0.5, 1);
    t.position.set(x, y - PLAYER_HALF_H - 16);
    effectsLayer.addChild(t);
    let ms = 0;
    const life = 900;
    effects.push({
      node: t,
      update(dtMs) {
        ms += dtMs;
        const k = ms / life;
        t.position.set(x, y - PLAYER_HALF_H - 16 - DAMAGE_RISE_PX * k);
        t.alpha = Math.max(0, 1 - k);
        return ms < life;
      },
    });
  }

  app.ticker.add((ticker) => {
    for (const cb of frameCbs) cb(performance.now());

    if (tick < 0) {
      acc = 0; // never pre-accumulate before the sim starts
    } else {
      acc += Math.min(ticker.deltaMS / 1000, MAX_FRAME);
    }
    while (acc >= DT) {
      prev = curr;
      const sample = touch ? mergeInputs(input.sample(), touch.sample()) : input.sample();
      // Predict our own swing: attackFires reads the PRE-step state, exactly like
      // the server's replay, so the slash shows the instant the swing happens.
      if (attackFires(curr, sample)) spawnSlash(curr.x, curr.y, curr.facing);
      curr = stepPlayer(curr, sample, DEFAULT_MAP);
      tick += 1;
      acc -= DT;
      for (const cb of tickCbs) cb(curr, tick, packInput(sample));
    }

    const alpha = acc / DT;
    const rx = prev.x + (curr.x - prev.x) * alpha;
    const ry = prev.y + (curr.y - prev.y) * alpha;
    // Smoothing is render-only: shift the sprite by the decaying correction
    // offset, but leave prev/curr (the simulation truth) untouched.
    localOffset = decayOffset(localOffset, ticker.deltaMS);
    const sx = rx + localOffset.x;
    const sy = ry + localOffset.y;
    local.root.position.set(sx, sy);
    local.body.scale.x = curr.facing;

    // Advance and reap transient effects.
    for (let i = effects.length - 1; i >= 0; i--) {
      if (!effects[i].update(ticker.deltaMS)) {
        effects[i].node.destroy({ children: true });
        effects.splice(i, 1);
      }
    }

    if (deathFlashMs > 0) {
      deathFlashMs = Math.max(0, deathFlashMs - ticker.deltaMS);
      deathFlash.alpha = (deathFlashMs / DEATH_FLASH_MS) * 0.6;
    }

    const cam = cameraOffset(sx, sy, VIEW_W, VIEW_H, WORLD_WIDTH, WORLD_HEIGHT);
    world.position.set(cam.x, cam.y);
  });

  return {
    destroy() {
      input.dispose();
      touch?.dispose();
      app.destroy(true, { children: true });
    },
    setLocalPlayerName(name) {
      local.label.text = name;
    },
    start(state, t) {
      prev = curr = state;
      tick = t;
      acc = 0; // clamp so the first running frame doesn't replay a burst
      localOffset = { x: 0, y: 0 };
    },
    resetLocal(state, t) {
      // Carry the visual error: where we render now (incl. the live offset) vs.
      // the corrected state. prev/curr jump to the truth; the sprite eases over.
      const alpha = acc / DT;
      const renderedBefore = {
        x: prev.x + (curr.x - prev.x) * alpha + localOffset.x,
        y: prev.y + (curr.y - prev.y) * alpha + localOffset.y,
      };
      prev = curr = state;
      tick = t;
      localOffset = correctionOffset(renderedBefore, { x: state.x, y: state.y });
    },
    onLocalTick(cb) {
      tickCbs.push(cb);
    },
    onFrame(cb) {
      frameCbs.push(cb);
    },
    upsertRemotePlayer(id, name, x, y, facing) {
      let view = remotes.get(id);
      if (!view) {
        view = createPlayerView(world, name, REMOTE_COLOR);
        remotes.set(id, view);
      }
      view.label.text = name;
      view.root.position.set(x, y);
      // Flip only the body; flipping the root would mirror the name label.
      view.body.scale.x = facing;
    },
    removeRemotePlayer(id) {
      const view = remotes.get(id);
      if (!view) return;
      view.root.destroy({ children: true });
      remotes.delete(id);
    },
    upsertMob(id, kind, x, y, dir, hp) {
      let view = mobs.get(id);
      if (!view) {
        view = createMobView(world, kind);
        mobs.set(id, view);
      }
      // Dead mobs (hp <= 0) are hidden rather than removed, so the SAME row
      // reappears on respawn without churning the map.
      view.root.visible = hp > 0;
      view.root.position.set(x, y);
      view.body.scale.x = dir < 0 ? -1 : 1;
      const max = MOB_STATS[kind].maxHp;
      const frac = Math.max(0, Math.min(1, hp / max));
      view.hpBar.visible = hp > 0 && hp < max;
      view.hpFill.scale.x = frac;
    },
    removeMob(id) {
      const view = mobs.get(id);
      if (!view) return;
      view.root.destroy({ children: true });
      mobs.delete(id);
    },
    spawnDamageNumber,
    setHud(hp, maxHp, xp, xpNext, level) {
      hud.set(hp, maxHp, xp, xpNext, level);
    },
    showRemoteSlash(idHex, facing) {
      const view = remotes.get(idHex);
      if (!view) return;
      spawnSlash(view.root.position.x, view.root.position.y, facing);
    },
    showLevelUp() {
      spawnLevelUp(local.root.position.x, local.root.position.y);
    },
    showDeathFlash() {
      deathFlashMs = DEATH_FLASH_MS;
    },
  };
}

/** A mob view: colored rectangle body + an HP bar that hides at full health. */
// (createMobView / createHud defined below.)
function createMobView(world: Container, kind: MobKind): MobView {
  const { w, h } = MOB_RENDER[kind];
  const root = new Container();
  const body = new Graphics().rect(-w / 2, -h / 2, w, h).fill(MOB_COLORS[kind]);

  const hpBar = new Container();
  hpBar.y = -h / 2 - 8;
  const bg = new Graphics().rect(-HP_BAR_W / 2, 0, HP_BAR_W, HP_BAR_H).fill(HP_BAR_BG);
  // Fill anchored at its left edge so scaling x shrinks it from the right.
  const hpFill = new Graphics().rect(0, 0, HP_BAR_W, HP_BAR_H).fill(HP_BAR_FG);
  hpFill.x = -HP_BAR_W / 2;
  hpBar.addChild(bg, hpFill);
  hpBar.visible = false;

  root.addChild(body, hpBar);
  world.addChild(root);
  return { root, body, hpBar, hpFill, kind };
}

/** Bottom-left HP/XP bars fixed to the stage. */
function createHud() {
  const container = new Container();
  const X = 16;
  const Y = VIEW_H - 56;
  const BAR_W = 180;
  const BAR_H = 14;

  const label = new Text({ text: 'Lv.1', style: HUD_STYLE });
  label.position.set(X, Y - 20);

  const hpBg = new Graphics().rect(X, Y, BAR_W, BAR_H).fill(HP_BAR_BG);
  const hpFill = new Graphics().rect(0, 0, BAR_W, BAR_H).fill(0xbf616a);
  hpFill.position.set(X, Y);

  const xpBg = new Graphics().rect(X, Y + BAR_H + 4, BAR_W, BAR_H).fill(HP_BAR_BG);
  const xpFill = new Graphics().rect(0, 0, BAR_W, BAR_H).fill(0xebcb8b);
  xpFill.position.set(X, Y + BAR_H + 4);

  container.addChild(label, hpBg, hpFill, xpBg, xpFill);

  return {
    container,
    set(hp: number, maxHp: number, xp: number, xpNext: number, level: number) {
      label.text = `Lv.${level}`;
      hpFill.scale.x = Math.max(0, Math.min(1, maxHp > 0 ? hp / maxHp : 0));
      xpFill.scale.x = Math.max(0, Math.min(1, xpNext > 0 ? xp / xpNext : 0));
    },
  };
}
