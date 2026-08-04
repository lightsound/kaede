// fallow-ignore-file coverage-gaps -- drives PixiJS against a live WebGL canvas; the logic worth testing is extracted into camera.ts, input.ts, and smoothing.ts, which are unit-tested
import {
  type CollisionMap,
  DEFAULT_MAP,
  DT,
  type E2EHook,
  type E2EPlayerSnapshot,
  type Facing,
  PLAYER_HALF_H,
  PLAYER_HALF_W,
  type PlayerState,
  packInput,
  type ReactionEmoji,
  SPAWN_X,
  SPAWN_Y,
  stepPlayer,
  WORLD_HEIGHT,
  WORLD_WIDTH,
} from '@kaede/shared';
import { Application, Container, Graphics, Text, TextStyle } from 'pixi.js';
import { correctionOffset, decayOffset, type Vec2 } from '../smoothing.package';
import {
  type Bubble,
  createBubble,
  createReactionBadge,
  expireOverhead,
  layoutReaction,
  type ReactionBadge,
  showBubble,
  showReaction,
  visibleBubbleText,
  visibleReactionEmoji,
} from './bubble';
import { cameraOffset } from './camera';
import { createInput } from './input';
import { mergeInputs } from './mergeInputs';
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

/**
 * The per-player display attributes rendered alongside the pose: the name
 * label and the status line under the avatar (`undefined` while default).
 * One object rather than adjacent positional strings so a swapped call
 * site cannot compile (the NetHooks precedent), and so the Phase 5 avatar
 * attributes (pose, gear) land as fields instead of a seventh parameter.
 */
export interface PlayerLabel {
  name: string;
  status: string | undefined;
}

export interface GameApp {
  destroy(): void;
  setLocalPlayerName(name: string): void;
  /**
   * Shows `status` (the composed line from statusLabel) under the local
   * avatar, or hides the line when undefined (the default status). Persistent
   * state, not a timed overhead — it stays until the next call.
   */
  setLocalStatus(status: string | undefined): void;
  /**
   * Begin stepping the local simulation from `state` at `tick`. Until this is
   * called the ticker renders the scene but never steps physics or fires
   * onLocalTick, so the client waits for the authoritative spawn row.
   */
  start(state: PlayerState, tick: number): void;
  /**
   * Re-gate the simulation (the pre-start state): physics stops stepping and
   * input is ignored until the next start(). Rendering continues from the
   * last pose. For when the own player row stops existing — a kicked or
   * swept player must not keep walking a ghost around under the overlay.
   */
  stop(): void;
  /**
   * Reconciliation hook: snap prev=curr=state and the tick counter to `tick`.
   * Rendering jumps to the corrected state (intended).
   */
  resetLocal(state: PlayerState, tick: number): void;
  onLocalTick(cb: (state: PlayerState, tick: number, packedInput: number) => void): void;
  onFrame(cb: (nowMs: number) => void): void;
  upsertRemotePlayer(id: string, label: PlayerLabel, x: number, y: number, facing: Facing): void;
  removeRemotePlayer(id: string): void;
  /** Drop every remote player sprite (e.g. when the connection is lost). */
  clearRemotePlayers(): void;
  /**
   * Shows `text` in a speech bubble above the local avatar for
   * CHAT_BUBBLE_DURATION_MS; a newer message replaces it and restarts the
   * clock.
   */
  showLocalBubble(text: string): void;
  /** Same, above the remote player `id`; a no-op while that player has no sprite. */
  showRemoteBubble(id: string, text: string): void;
  /**
   * Shows `emoji` above the local avatar for REACTION_DURATION_MS; a newer
   * reaction replaces it and restarts the clock. Stacks above the speech
   * bubble when one is visible (see layoutReaction).
   */
  showLocalReaction(emoji: ReactionEmoji): void;
  /** Same, above the remote player `id`; a no-op while that player has no sprite. */
  showRemoteReaction(id: string, emoji: ReactionEmoji): void;
}

interface PlayerView {
  root: Container;
  body: Graphics;
  label: Text;
  /** The status line under the avatar, hidden while the status is default (setViewStatus). */
  status: Text;
  /** The speech bubble, hidden until this player chats (showBubble). */
  bubble: Bubble;
  /** The emoji reaction, hidden until this player reacts (showReaction). */
  reaction: ReactionBadge;
}

// The status line (ROADMAP Phase 2): dimmer and smaller than the name so
// the name stays the anchor. It sits UNDER the avatar — the slot above the
// name belongs to the transient overheads (bubble, reaction stack), and a
// persistent line there would collide with both.
const STATUS_STYLE = new TextStyle({ fill: 0xb8c2d9, fontSize: 11, fontFamily: 'sans-serif' });

/** The status line's Text, parked under the avatar and hidden until a status arrives. */
function createStatusText(): Text {
  const status = new Text({ text: '', style: STATUS_STYLE });
  status.anchor.set(0.5, 0);
  status.y = PLAYER_HALF_H + 4;
  status.visible = false;
  return status;
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
  const status = createStatusText();
  const bubble = createBubble();
  const reaction = createReactionBadge();
  root.addChild(body, label, status, bubble.root, reaction.root);
  world.addChild(root);
  return { root, body, label, status, bubble, reaction };
}

/**
 * Applies a composed status line (statusLabel in @kaede/shared, undefined
 * while default) to one view. Unlike the transient overheads there is no
 * timer: a status is state, visible until the next row event replaces it.
 */
function setViewStatus(view: PlayerView, status: string | undefined): void {
  view.status.visible = status !== undefined;
  view.status.text = status ?? '';
}

/**
 * One player as the e2e hook reports it: rendered pose plus any live
 * overheads and the status line. The optional fields are guarded
 * assignments (one uniform shape) rather than conditional spreads — three
 * spread ternaries put this uncovered function over the CRAP budget
 * fallow enforces.
 */
function playerSnapshot(view: PlayerView): E2EPlayerSnapshot {
  const snap: E2EPlayerSnapshot = { x: view.root.x, y: view.root.y, name: view.label.text };
  const bubble = visibleBubbleText(view.bubble);
  if (bubble !== undefined) snap.bubble = bubble;
  const reaction = visibleReactionEmoji(view.reaction);
  if (reaction !== undefined) snap.reaction = reaction;
  if (view.status.visible) snap.status = view.status.text;
  return snap;
}

/**
 * Test affordance for the Playwright smoke tests — see E2EHook in
 * @kaede/shared for the contract and who consumes it. Constructed only in dev
 * builds, so the build-time DEV constant lets production bundles drop the
 * hook code entirely.
 */
function createE2EHook(
  local: PlayerView,
  remotes: Map<string, PlayerView>,
  currentTick: () => number,
): E2EHook | undefined {
  if (!import.meta.env.DEV) return undefined;
  return {
    snapshot: () => ({
      tick: currentTick(),
      local: playerSnapshot(local),
      remotePlayers: [...remotes.values()].map(playerSnapshot),
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

  /**
   * Hides one view's overhead displays whose time is up (see
   * expireOverhead) and keeps its reaction stacked clear of its bubble —
   * re-laid out every frame because either can appear, resize or expire
   * mid-display.
   */
  function expireViewOverheads(view: PlayerView, nowMs: number): void {
    expireOverhead(view.bubble, nowMs);
    expireOverhead(view.reaction, nowMs);
    layoutReaction(view.reaction, view.bubble);
  }

  function expireOverheads(nowMs: number): void {
    expireViewOverheads(local, nowMs);
    for (const view of remotes.values()) expireViewOverheads(view, nowMs);
  }

  app.ticker.add((ticker) => {
    const now = performance.now();
    for (const cb of frameCbs) cb(now);
    // Simulation is gated until start(): never pre-accumulate before it runs.
    acc = tick < 0 ? 0 : acc + Math.min(ticker.deltaMS / 1000, MAX_FRAME);
    while (acc >= DT) simulateTick();
    renderLocal(ticker.deltaMS);
    expireOverheads(now);
  });

  const e2eHook = createE2EHook(local, remotes, () => tick);

  /** Runs `act` on the remote player's view; a no-op while it has no sprite. */
  function withRemoteView(id: string, act: (view: PlayerView) => void): void {
    const view = remotes.get(id);
    if (view) act(view);
  }

  return {
    destroy() {
      // Guarded so a torn-down instance cannot erase a hook installed by the
      // instance that outlives it (StrictMode mounts two in parallel).
      if (e2eHook && window.__kaedeE2E === e2eHook) window.__kaedeE2E = undefined;
      input.dispose();
      touch?.dispose();
      app.destroy(true, { children: true });
    },
    setLocalPlayerName(name) {
      local.label.text = name;
    },
    setLocalStatus(status) {
      setViewStatus(local, status);
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
      if (e2eHook) window.__kaedeE2E = e2eHook;
    },
    stop() {
      tick = -1; // the ticker treats tick < 0 as "not running" (see start)
      acc = 0;
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
    upsertRemotePlayer(id, label, x, y, facing) {
      let view = remotes.get(id);
      if (!view) {
        view = createPlayerView(world, label.name, REMOTE_COLOR);
        remotes.set(id, view);
      }
      view.label.text = label.name;
      setViewStatus(view, label.status);
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
    showLocalBubble: (text) => showBubble(local.bubble, text, performance.now()),
    showRemoteBubble: (id, text) =>
      withRemoteView(id, (view) => showBubble(view.bubble, text, performance.now())),
    showLocalReaction: (emoji) => showReaction(local.reaction, emoji, performance.now()),
    showRemoteReaction: (id, emoji) =>
      withRemoteView(id, (view) => showReaction(view.reaction, emoji, performance.now())),
  };
}
