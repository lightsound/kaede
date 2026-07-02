import {
  DEFAULT_MAP,
  type Facing,
  PLAYER_HALF_H,
  PLAYER_HALF_W,
  type PlayerState,
  packInput,
  WORLD_HEIGHT,
  WORLD_WIDTH,
} from '@maple/shared';
import { Application, Container, Graphics, Text, TextStyle } from 'pixi.js';
import { cameraOffset } from './camera';
import { createInput, mergeInputs } from './input';
import { createLocalSim } from './localSim';
import { createTouchControls } from './touchControls';

const VIEW_W = 1280;
const VIEW_H = 720;

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

/** The remote player sprites, keyed by identity hex. */
function createRemoteRoster(world: Container) {
  const remotes = new Map<string, PlayerView>();
  return {
    upsert(id: string, name: string, x: number, y: number, facing: Facing): void {
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
    remove(id: string): void {
      const view = remotes.get(id);
      if (!view) return;
      view.root.destroy({ children: true });
      remotes.delete(id);
    },
    clear(): void {
      for (const view of remotes.values()) view.root.destroy({ children: true });
      remotes.clear();
    },
  };
}

/**
 * Static map geometry. Ropes hang behind everything; platforms and the ground
 * slab draw on top of them. Everything lives in one Graphics, which the caller
 * adds to the world before any player view, so the whole map renders behind
 * players.
 */
function buildMapGraphics(): Graphics {
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
  return mapGfx;
}

/** Keyboard input plus the optional touch overlay, merged into one sampler. */
function createInputSources(stage: Container) {
  const input = createInput();
  // Touch overlay: only built on coarse-pointer / touch-capable devices. Added
  // to the stage (not world) so it stays fixed in screen space, above the world.
  const wantsTouch = window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
  const touch = wantsTouch ? createTouchControls() : undefined;
  if (touch) stage.addChild(touch.container);
  return {
    sample: () => (touch ? mergeInputs(input.sample(), touch.sample()) : input.sample()),
    dispose(): void {
      input.dispose();
      touch?.dispose();
    },
  };
}

export async function createGameApp(host: HTMLElement): Promise<GameApp> {
  const app = new Application();
  await app.init({ width: VIEW_W, height: VIEW_H, background: BG_COLOR, antialias: false });
  host.appendChild(app.canvas);

  const world = new Container();
  app.stage.addChild(world);
  world.addChild(buildMapGraphics());

  const local = createPlayerView(world, 'You', LOCAL_COLOR);
  const remotes = createRemoteRoster(world);
  const inputs = createInputSources(app.stage);

  const tickCbs: ((s: PlayerState, tick: number, packedInput: number) => void)[] = [];
  const frameCbs: ((nowMs: number) => void)[] = [];

  const sim = createLocalSim((state, tick, sample) => {
    for (const cb of tickCbs) cb(state, tick, packInput(sample));
  });

  app.ticker.add((ticker) => {
    for (const cb of frameCbs) cb(performance.now());

    sim.advance(ticker.deltaMS, inputs.sample);

    const pose = sim.renderPose();
    local.root.position.set(pose.x, pose.y);
    local.body.scale.x = pose.facing;

    const cam = cameraOffset(pose.x, pose.y, VIEW_W, VIEW_H, WORLD_WIDTH, WORLD_HEIGHT);
    world.position.set(cam.x, cam.y);
  });

  return {
    destroy() {
      inputs.dispose();
      app.destroy(true, { children: true });
    },
    setLocalPlayerName(name) {
      local.label.text = name;
    },
    start(state, t) {
      sim.start(state, t);
    },
    resetLocal(state, t) {
      sim.reset(state, t);
    },
    onLocalTick(cb) {
      tickCbs.push(cb);
    },
    onFrame(cb) {
      frameCbs.push(cb);
    },
    upsertRemotePlayer(id, name, x, y, facing) {
      remotes.upsert(id, name, x, y, facing);
    },
    removeRemotePlayer(id) {
      remotes.remove(id);
    },
    clearRemotePlayers() {
      remotes.clear();
    },
  };
}
