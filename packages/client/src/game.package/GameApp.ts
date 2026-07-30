// fallow-ignore-file coverage-gaps -- drives PixiJS against a live WebGL canvas; the logic worth testing is extracted into camera.ts, input.ts, and smoothing.ts, which are unit-tested
import {
  type CollisionMap,
  DEFAULT_MAP,
  DT,
  type E2EHook,
  type Facing,
  PLAYER_HALF_H,
  PLAYER_HALF_W,
  type PlayerState,
  packInput,
  SPAWN_X,
  SPAWN_Y,
  stepPlayer,
  WORLD_HEIGHT,
  WORLD_WIDTH,
} from '@maple/shared';
import { Application, Container, Graphics, Text, TextStyle } from 'pixi.js';
import { correctionOffset, decayOffset, type Vec2 } from '../smoothing.package';
import { cameraOffset } from './camera';
import { createInput, mergeInputs } from './input';
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
  upsertRemotePlayer(id: string, name: string, x: number, y: number, facing: Facing): void;
  removeRemotePlayer(id: string): void;
  /** Drop every remote player sprite (e.g. when the connection is lost). */
  clearRemotePlayers(): void;
}

interface PlayerView {
  root: Container;
  body: Graphics;
  label: Text;
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

/**
 * Test affordance for the Playwright smoke tests — see E2EHook in
 * @maple/shared for the contract and who consumes it. Constructed only in dev
 * builds, so the build-time DEV constant lets production bundles drop the
 * hook code entirely.
 */
function createE2EHook(local: PlayerView, remotes: Map<string, PlayerView>): E2EHook | undefined {
  if (!import.meta.env.DEV) return undefined;
  return {
    snapshot: () => ({
      local: { x: local.root.x, y: local.root.y },
      remotePlayers: [...remotes.entries()].map(([id, view]) => ({
        id,
        name: view.label.text,
        x: view.root.x,
        y: view.root.y,
      })),
    }),
  };
}

/**
 * The static map geometry as one Graphics. Ropes hang behind everything;
 * platforms and the ground slab draw on top of them. Added to the world before
 * any player view, so the whole map renders behind players.
 */
function drawMap(map: CollisionMap): Graphics {
  const gfx = new Graphics();
  for (const r of map.ropes) {
    // Visual span: rope.top down to rope.bottom + PLAYER_HALF_H (the lower end
    // rests on a floor, while rope.bottom bounds the climbing player's center).
    gfx
      .rect(r.x - ROPE_WIDTH / 2, r.top, ROPE_WIDTH, r.bottom + PLAYER_HALF_H - r.top)
      .fill(ROPE_COLOR);
  }
  for (const s of map.solids) gfx.rect(s.x, s.y, s.w, s.h).fill(SOLID_COLOR);
  for (const p of map.platforms) gfx.rect(p.x, p.y, p.w, p.h).fill(PLATFORM_COLOR);
  return gfx;
}

export async function createGameApp(host: HTMLElement): Promise<GameApp> {
  const app = new Application();
  await app.init({ width: VIEW_W, height: VIEW_H, background: BG_COLOR, antialias: false });
  host.appendChild(app.canvas);

  const world = new Container();
  app.stage.addChild(world);
  world.addChild(drawMap(DEFAULT_MAP));

  const local = createPlayerView(world, 'You', LOCAL_COLOR);
  const remotes = new Map<string, PlayerView>();

  const input = createInput();

  // Touch overlay: only built on coarse-pointer / touch-capable devices. Added
  // to app.stage (not world) so it stays fixed in screen space, above the world.
  const wantsTouch = window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
  const touch = wantsTouch ? createTouchControls() : undefined;
  if (touch) app.stage.addChild(touch.container);

  const tickCbs: ((s: PlayerState, tick: number, packedInput: number) => void)[] = [];
  const frameCbs: ((nowMs: number) => void)[] = [];

  let prev: PlayerState = {
    x: SPAWN_X,
    y: SPAWN_Y,
    vx: 0,
    vy: 0,
    facing: 1,
    onGround: false,
    rope: -1,
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

  /** One fixed simulation tick: sample every input source, step, notify. */
  function simulateTick(): void {
    prev = curr;
    const sample = touch ? mergeInputs(input.sample(), touch.sample()) : input.sample();
    curr = stepPlayer(curr, sample, DEFAULT_MAP);
    tick += 1;
    acc -= DT;
    for (const cb of tickCbs) cb(curr, tick, packInput(sample));
  }

  /** Place the local sprite and the camera for the current interpolation alpha. */
  function renderLocal(deltaMS: number): void {
    const alpha = acc / DT;
    const rx = prev.x + (curr.x - prev.x) * alpha;
    const ry = prev.y + (curr.y - prev.y) * alpha;
    // Smoothing is render-only: shift the sprite by the decaying correction
    // offset, but leave prev/curr (the simulation truth) untouched.
    localOffset = decayOffset(localOffset, deltaMS);
    const sx = rx + localOffset.x;
    const sy = ry + localOffset.y;
    local.root.position.set(sx, sy);
    local.body.scale.x = curr.facing;

    const cam = cameraOffset(sx, sy, VIEW_W, VIEW_H, WORLD_WIDTH, WORLD_HEIGHT);
    world.position.set(cam.x, cam.y);
  }

  app.ticker.add((ticker) => {
    for (const cb of frameCbs) cb(performance.now());
    // Simulation is gated until start(): never pre-accumulate before it runs.
    acc = tick < 0 ? 0 : acc + Math.min(ticker.deltaMS / 1000, MAX_FRAME);
    while (acc >= DT) simulateTick();
    renderLocal(ticker.deltaMS);
  });

  const e2eHook = createE2EHook(local, remotes);

  return {
    destroy() {
      // Guarded so a torn-down instance cannot erase a hook installed by the
      // instance that outlives it (StrictMode mounts two in parallel).
      if (e2eHook && window.__mapleE2E === e2eHook) window.__mapleE2E = undefined;
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
      // Installed here rather than at creation: only the instance that the
      // network wires up ever starts, whereas StrictMode creates two instances
      // concurrently and creation-time installs can interleave so that the
      // doomed instance installs last and its destroy() clears the hook.
      if (e2eHook) window.__mapleE2E = e2eHook;
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
    clearRemotePlayers() {
      for (const view of remotes.values()) view.root.destroy({ children: true });
      remotes.clear();
    },
  };
}
