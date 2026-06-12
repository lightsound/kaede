import {
  DEFAULT_MAP,
  DT,
  PLAYER_HALF_H,
  PLAYER_HALF_W,
  SPAWN_X,
  SPAWN_Y,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  packInput,
  stepPlayer,
  type Facing,
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

export async function createGameApp(host: HTMLElement): Promise<GameApp> {
  const app = new Application();
  await app.init({ width: VIEW_W, height: VIEW_H, background: BG_COLOR, antialias: false });
  host.appendChild(app.canvas);

  const world = new Container();
  app.stage.addChild(world);

  // Static map geometry.
  const mapGfx = new Graphics();
  for (const s of DEFAULT_MAP.solids) mapGfx.rect(s.x, s.y, s.w, s.h).fill(SOLID_COLOR);
  world.addChild(mapGfx);

  const local = createPlayerView(world, 'You', LOCAL_COLOR);
  const remotes = new Map<string, PlayerView>();

  const input = createInput();

  // Touch overlay: only built on coarse-pointer / touch-capable devices. Added
  // to app.stage (not world) so it stays fixed in screen space, above the world.
  const wantsTouch =
    window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
  const touch = wantsTouch ? createTouchControls() : undefined;
  if (touch) app.stage.addChild(touch.container);

  const tickCbs: ((s: PlayerState, tick: number, packedInput: number) => void)[] = [];
  const frameCbs: ((nowMs: number) => void)[] = [];

  let prev: PlayerState = { x: SPAWN_X, y: SPAWN_Y, vx: 0, vy: 0, facing: 1, onGround: false };
  let curr: PlayerState = prev;
  let acc = 0;
  // Simulation is gated until start(): tick < 0 means "not yet running".
  let tick = -1;
  // Render-only smoothing for reconciliation corrections: the decaying error
  // between where we last rendered and the new corrected state. The simulation
  // state (prev/curr) always holds the exact corrected value; this offset only
  // shifts the sprite, never the physics.
  let localOffset: Vec2 = { x: 0, y: 0 };

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
  };
}
