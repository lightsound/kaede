import {
  DT,
  MAPS,
  MOB_STATS,
  PLAYER_HALF_H,
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
import { NORD_RED } from './colors';
import { createEffects, type DamageKind } from './effects';
import { createInput, mergeInputs } from './input';
import { createMapGfx, createScene, type MapGfx } from './scene/background';
import { createHud } from './scene/hud';
import { correctionOffset, decayOffset, type Vec2 } from './smoothing';
import { createCharacterRig, type CharacterRig, type Pose } from './sprites/character';
import { createMobRig, type MobRig } from './sprites/mobs';
import { createTouchControls } from './touchControls';

const VIEW_W = 1280;
const VIEW_H = 720;
const MAX_FRAME = 0.25;

const BG_COLOR = 0x10131b;
const LOCAL_COLOR = 0x88c0d0;
const REMOTE_COLOR = 0xd08770;

// HP bars: shown above a mob only while hurt.
const HP_BAR_W = 36;
const HP_BAR_H = 4;
const HP_BAR_BG = 0x2e3440;
const HP_BAR_FG = NORD_RED;

// The arm-swing animation window. The slash effect fades fast; the arm holds its
// forward swing a touch longer so the gesture reads clearly.
const ATTACK_ANIM_MS = 120;
const DEATH_FLASH_MS = 200;
const DEATH_FLASH_COLOR = NORD_RED;

// Chat speech bubbles: a rounded near-white panel of dark text that floats above
// a player's name label and follows them (it's parented to the player's root).
const SPEECH_LIFE_MS = 4000;
const SPEECH_WRAP_PX = 180;
const SPEECH_PAD = 6;
const SPEECH_BG = 0xf4f6fb;
const SPEECH_BG_ALPHA = 0.92;
const SPEECH_TEXT = 0x10131b;
const SPEECH_STYLE = new TextStyle({
  fill: SPEECH_TEXT,
  fontSize: 12,
  fontFamily: 'sans-serif',
  wordWrap: true,
  wordWrapWidth: SPEECH_WRAP_PX,
  breakWords: true, // long unbroken strings (e.g. URLs) must still wrap
});
// Speech bubbles are keyed like the player views; the local player has no id hex.
const SPEECH_LOCAL_KEY = 'local';

const NAME_STYLE = new TextStyle({ fill: 0xffffff, fontSize: 13, fontFamily: 'sans-serif' });

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
  /**
   * Subscribe to local map changes. GameApp owns the detection (it sees the
   * predicted/reconciled sim state) and fires this with the new mapId AFTER it
   * has swapped geometry and cleared old-map effects, so sync can re-filter and
   * re-seed remote/mob views for the new map.
   */
  onMapChange(cb: (mapId: number) => void): void;
  /**
   * Upsert a remote player view. vx/vy are the interpolated velocity (for
   * animation); onGround/climbing are the remote's authoritative pose columns
   * (no local heuristic), threaded straight into the rig.
   */
  upsertRemotePlayer(
    id: string,
    name: string,
    x: number,
    y: number,
    facing: Facing,
    vx: number,
    vy: number,
    onGround: boolean,
    climbing: boolean,
  ): void;
  removeRemotePlayer(id: string): void;
  /** Upsert a mob view; hidden when hp <= 0. vx is the interpolated x-velocity (waddle gate). */
  upsertMob(id: number, kind: MobKind, x: number, y: number, dir: number, hp: number, vx: number): void;
  removeMob(id: number): void;
  /** Floating combat text that rises and fades at world position (x, y). */
  spawnDamageNumber(x: number, y: number, amount: number, kind: DamageKind): void;
  /** Update the fixed HUD bars (HP red, XP-to-next yellow) and the level label. */
  setHud(hp: number, maxHp: number, xp: number, xpToNext: number, level: number): void;
  /** Render a remote player's swing at that view's current position. */
  showRemoteSlash(idHex: string, facing: Facing): void;
  /** A floating "LEVEL UP!" flash at the local player on level change. */
  showLevelUp(): void;
  /** Brief full-screen red flash when own hp hits 0. */
  showDeathFlash(): void;
  /**
   * Show a chat speech bubble over a player. `remoteIdHex` null targets the
   * local player; otherwise it's the remote player's id hex (no-op if that view
   * isn't currently rendered). A new message replaces that player's existing
   * bubble and resets its lifetime.
   */
  showSpeech(remoteIdHex: string | null, text: string): void;
}

interface PlayerView {
  root: Container;
  rig: CharacterRig;
  label: Text;
  /** Milliseconds left in the current attack-swing animation (0 = none). */
  attackMs: number;
  /** Latest interpolated motion + authoritative pose, fed by upsertRemotePlayer. */
  vx: number;
  vy: number;
  onGround: boolean;
  climbing: boolean;
}

interface MobView {
  root: Container;
  rig: MobRig;
  hpBar: Container;
  hpFill: Graphics;
  kind: MobKind;
  /** True while the mob's interpolated x-velocity says it's walking (waddle gate). */
  moving: boolean;
  /** Last hp we drew, so upsertMob can detect the alive->dead transition (poof). */
  lastHp: number;
}

/** A labelled character rig parented under the world container. */
function createPlayerView(world: Container, name: string, color: number): PlayerView {
  const root = new Container();
  const rig = createCharacterRig(color);
  const label = new Text({ text: name, style: NAME_STYLE });
  label.anchor.set(0.5, 1);
  label.y = -PLAYER_HALF_H - 4;
  // rig.body holds the mirror-able parts; the label stays unmirrored (a flip of
  // body.scale.x must never touch it), so both are direct children of the root.
  root.addChild(rig.body, label);
  world.addChild(root);
  return { root, rig, label, attackMs: 0, vx: 0, vy: 0, onGround: false, climbing: false };
}

/**
 * A rounded-rect chat bubble (dark text on a near-white panel) sized to its
 * wrapped text, anchored so its bottom tip sits at the bubble's local origin —
 * the caller positions that origin just above the name label so the bubble
 * floats over the player's head.
 */
function createSpeechBubble(text: string): Container {
  const node = new Container();
  const label = new Text({ text, style: SPEECH_STYLE });
  const w = label.width + SPEECH_PAD * 2;
  const h = label.height + SPEECH_PAD * 2;
  const bg = new Graphics()
    .roundRect(-w / 2, -h, w, h, 5)
    .fill({ color: SPEECH_BG, alpha: SPEECH_BG_ALPHA });
  label.position.set(-w / 2 + SPEECH_PAD, -h + SPEECH_PAD);
  node.addChild(bg, label);
  return node;
}

export async function createGameApp(host: HTMLElement): Promise<GameApp> {
  const app = new Application();
  await app.init({ width: VIEW_W, height: VIEW_H, background: BG_COLOR, antialias: false });
  host.appendChild(app.canvas);

  // Scene split: the backdrop (sky + parallax) is SCREEN-space and goes on the
  // stage behind the world; the map geometry is WORLD-space and goes inside the
  // world. This preserves the depth order: sky → parallax → ropes (behind
  // platforms) → players → effects → HUD.
  const scene = createScene(VIEW_W, VIEW_H);
  app.stage.addChild(scene.backdrop);

  const world = new Container();
  app.stage.addChild(world);

  // The current map's geometry. GameApp owns it (the backdrop is shared across
  // maps), swapping it on a map change. Built for map 0 here; start() rebuilds
  // it if we spawn on a different map (rejoin keeps mapId). It's the FIRST child
  // of world so it sits behind players/effects, matching the old depth order.
  let mapGfx: MapGfx = createMapGfx(MAPS[0]);
  world.addChild(mapGfx.node);
  let renderedMapId = 0;

  const mobs = new Map<number, MobView>();
  const local = createPlayerView(world, 'You', LOCAL_COLOR);
  const remotes = new Map<string, PlayerView>();

  // Transient effects subsystem (slashes, damage numbers, poofs, level-up, map
  // toast). It owns its two layers; we add the world-space one inside the world
  // (above players) and the screen-space one to the stage further below.
  const effects = createEffects();
  world.addChild(effects.worldLayer);

  // One speech bubble per player, keyed the same way as the player views
  // (SPEECH_LOCAL_KEY for the local player, the remote id hex otherwise). The
  // bubble node is parented to that player's root container so it FOLLOWS them;
  // we keep a parallel timer here to expire it. A new message for the same key
  // replaces the node and resets the timer.
  const speechBubbles = new Map<string, { node: Container; ms: number }>();

  // Screen-space overlay (HUD + death flash), added to the stage so it stays put.
  const hud = createHud(VIEW_H);
  app.stage.addChild(hud.container);
  const deathFlash = new Graphics().rect(0, 0, VIEW_W, VIEW_H).fill(DEATH_FLASH_COLOR);
  deathFlash.alpha = 0;
  app.stage.addChild(deathFlash);
  let deathFlashMs = 0;

  // Screen-space transient effects (the map-name toast): parented to the stage so
  // they stay centered regardless of camera. Advanced by the same effects loop.
  app.stage.addChild(effects.screenLayer);

  const input = createInput();

  // Touch overlay: only built on coarse-pointer / touch-capable devices. Added
  // to app.stage (not world) so it stays fixed in screen space, above the world.
  const wantsTouch =
    window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
  const touch = wantsTouch ? createTouchControls() : undefined;
  if (touch) app.stage.addChild(touch.container);

  const tickCbs: ((s: PlayerState, tick: number, packedInput: number) => void)[] = [];
  const frameCbs: ((nowMs: number) => void)[] = [];
  const mapChangeCbs: ((mapId: number) => void)[] = [];

  let prev: PlayerState = {
    x: SPAWN_X, y: SPAWN_Y, vx: 0, vy: 0, facing: 1, onGround: false, rope: -1, attackCooldown: 0, mapId: 0,
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

  /**
   * Swap the rendered geometry to `mapId`: destroy the old map gfx, build the
   * new one (behind players/effects), clear WORLD-space transient effects (old-
   * map damage numbers / slashes have no meaning on the new map), toast the map
   * name, and notify subscribers so sync can re-filter views. Called only when
   * the sim's mapId actually changed (GameApp owns that detection).
   */
  function switchMap(mapId: number): void {
    mapGfx.node.destroy({ children: true });
    mapGfx = createMapGfx(MAPS[mapId]);
    // Re-insert at index 0 so it stays BEHIND the effects layer and players.
    world.addChildAt(mapGfx.node, 0);
    renderedMapId = mapId;

    effects.clearWorld();

    effects.spawnMapToast(MAPS[mapId].name, VIEW_W, VIEW_H);
    for (const cb of mapChangeCbs) cb(mapId);
  }

  /** Pose for the LOCAL player straight from the interpolated sim state. */
  function localPose(attackMs: number): Pose {
    return {
      vx: curr.vx,
      vy: curr.vy,
      onGround: curr.onGround,
      climbing: curr.rope >= 0,
      attackSwingMs: attackMs,
    };
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
      if (attackFires(curr, sample)) {
        effects.spawnSlash(curr.x, curr.y, curr.facing);
        local.attackMs = ATTACK_ANIM_MS; // sync the arm swing with the slash
      }
      curr = stepPlayer(curr, sample, MAPS);
      // Map switch detection: a portal step inside stepPlayer changed mapId. The
      // PREDICTED state drives rendering, so the world swaps instantly (not after
      // the server ack). prev is snapped to curr so the post-teleport interpolation
      // doesn't streak across the old position.
      if (curr.mapId !== renderedMapId) {
        switchMap(curr.mapId);
        prev = curr;
        localOffset = { x: 0, y: 0 };
      }
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
    local.rig.body.scale.x = curr.facing;
    local.attackMs = Math.max(0, local.attackMs - ticker.deltaMS);
    local.rig.update(ticker.deltaMS, localPose(local.attackMs));

    // Animate every remote rig from its authoritative pose. Position/facing and
    // the pose fields are set in upsertRemotePlayer; here we only advance the rig
    // animation from those exact columns (no inference).
    for (const view of remotes.values()) {
      view.attackMs = Math.max(0, view.attackMs - ticker.deltaMS);
      view.rig.update(ticker.deltaMS, {
        vx: view.vx,
        vy: view.vy,
        onGround: view.onGround,
        climbing: view.climbing,
        attackSwingMs: view.attackMs,
      });
    }

    // Animate mob rigs (squash, waddle) from their last-known moving state.
    for (const view of mobs.values()) view.rig.update(ticker.deltaMS, view.moving);

    // Animate the current map's portals (swirl/pulse).
    mapGfx.update(ticker.deltaMS);

    // Advance and reap transient effects (world-space, then screen-space).
    effects.update(ticker.deltaMS);

    // Expire speech bubbles. They ride their player's root, so no per-frame
    // repositioning is needed — only the lifetime is ticked here.
    for (const [key, bubble] of speechBubbles) {
      bubble.ms -= ticker.deltaMS;
      if (bubble.ms <= 0) {
        bubble.node.destroy({ children: true });
        speechBubbles.delete(key);
      }
    }

    if (deathFlashMs > 0) {
      deathFlashMs = Math.max(0, deathFlashMs - ticker.deltaMS);
      deathFlash.alpha = (deathFlashMs / DEATH_FLASH_MS) * 0.6;
    }

    const cam = cameraOffset(sx, sy, VIEW_W, VIEW_H, WORLD_WIDTH, WORLD_HEIGHT);
    world.position.set(cam.x, cam.y);
    scene.update(cam.x, cam.y);
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
      // Rejoin can spawn us on a non-0 map: build the STARTING map's geometry,
      // not always map 0. switchMap also toasts the name and notifies sync to
      // seed views for the right map.
      if (state.mapId !== renderedMapId) switchMap(state.mapId);
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
      // Reconciliation can land us on a different map (e.g. a death-respawn to
      // town the client didn't predict). Swap geometry to the corrected map and
      // don't carry a stale cross-map smoothing offset.
      if (state.mapId !== renderedMapId) {
        switchMap(state.mapId);
        localOffset = { x: 0, y: 0 };
      }
    },
    onLocalTick(cb) {
      tickCbs.push(cb);
    },
    onFrame(cb) {
      frameCbs.push(cb);
    },
    onMapChange(cb) {
      mapChangeCbs.push(cb);
    },
    upsertRemotePlayer(id, name, x, y, facing, vx, vy, onGround, climbing) {
      let view = remotes.get(id);
      if (!view) {
        view = createPlayerView(world, name, REMOTE_COLOR);
        remotes.set(id, view);
      }
      view.label.text = name;
      view.root.position.set(x, y);
      // Flip only the body; flipping the root would mirror the name label.
      view.rig.body.scale.x = facing;
      view.vx = vx;
      view.vy = vy;
      view.onGround = onGround;
      view.climbing = climbing;
    },
    removeRemotePlayer(id) {
      const view = remotes.get(id);
      if (!view) return;
      // The bubble is a child of view.root, so destroying the root destroys it
      // too; drop the map entry so the expiry loop doesn't touch a dead node.
      speechBubbles.delete(id);
      view.root.destroy({ children: true });
      remotes.delete(id);
    },
    upsertMob(id, kind, x, y, dir, hp, vx) {
      let view = mobs.get(id);
      if (!view) {
        view = createMobView(world, kind);
        mobs.set(id, view);
      }
      // alive -> dead this frame: puff at the mob's spot before it hides.
      if (view.lastHp > 0 && hp <= 0) effects.spawnDeathPoof(x, y, kind);
      view.lastHp = hp;
      // Dead mobs (hp <= 0) are hidden rather than removed, so the SAME row
      // reappears on respawn without churning the map.
      view.root.visible = hp > 0;
      view.root.position.set(x, y);
      view.rig.body.scale.x = dir < 0 ? -1 : 1;
      view.moving = Math.abs(vx) > 1;
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
    spawnDamageNumber(x, y, amount, kind) {
      effects.spawnDamageNumber(x, y, amount, kind);
    },
    setHud(hp, maxHp, xp, xpNext, level) {
      hud.set(hp, maxHp, xp, xpNext, level);
    },
    showRemoteSlash(idHex, facing) {
      const view = remotes.get(idHex);
      if (!view) return;
      effects.spawnSlash(view.root.position.x, view.root.position.y, facing);
      view.attackMs = ATTACK_ANIM_MS; // swing the rig's arm to match the slash
    },
    showLevelUp() {
      effects.spawnLevelUp(local.root.position.x, local.root.position.y);
    },
    showDeathFlash() {
      deathFlashMs = DEATH_FLASH_MS;
    },
    showSpeech(remoteIdHex, text) {
      const key = remoteIdHex ?? SPEECH_LOCAL_KEY;
      // Resolve the player's root. A remote whose view isn't currently rendered
      // (off-screen / just dropped) has no root, so there's nowhere to show it.
      const root = remoteIdHex === null ? local.root : remotes.get(remoteIdHex)?.root;
      if (!root) return;

      // One bubble per player: drop the previous node before adding the new one,
      // which also resets the lifetime below.
      speechBubbles.get(key)?.node.destroy({ children: true });

      const node = createSpeechBubble(text);
      // Sit just above the name label (label top edge is at -PLAYER_HALF_H - 4).
      node.y = -PLAYER_HALF_H - 18;
      root.addChild(node);
      speechBubbles.set(key, { node, ms: SPEECH_LIFE_MS });
    },
  };
}

/** A mob view: animated procedural rig + an HP bar that hides at full health. */
function createMobView(world: Container, kind: MobKind): MobView {
  const root = new Container();
  const rig = createMobRig(kind);

  const hpBar = new Container();
  // Sit the bar above the mob's drawing (halfH from center, plus a gap).
  hpBar.y = -MOB_STATS[kind].halfH - 10;
  const bg = new Graphics().rect(-HP_BAR_W / 2, 0, HP_BAR_W, HP_BAR_H).fill(HP_BAR_BG);
  // Fill anchored at its left edge so scaling x shrinks it from the right.
  const hpFill = new Graphics().rect(0, 0, HP_BAR_W, HP_BAR_H).fill(HP_BAR_FG);
  hpFill.x = -HP_BAR_W / 2;
  hpBar.addChild(bg, hpFill);
  hpBar.visible = false;

  root.addChild(rig.body, hpBar);
  world.addChild(root);
  return { root, rig, hpBar, hpFill, kind, moving: false, lastHp: MOB_STATS[kind].maxHp };
}
