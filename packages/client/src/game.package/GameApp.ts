// fallow-ignore-file coverage-gaps -- drives PixiJS against a live WebGL canvas; the logic worth testing is extracted into camera.ts, input.ts, and smoothing.ts, which are unit-tested
import {
  DEFAULT_MAP_ID,
  DT,
  type Facing,
  mapFor,
  type PlayerState,
  packInput,
  type ReactionEmoji,
  SPAWN_X,
  SPAWN_Y,
  stepPlayer,
  WORLD_HEIGHT,
  type WorldMap,
} from '@kaede/shared';
import { Application, Container } from 'pixi.js';
import { correctionOffset, decayOffset, type Vec2 } from '../smoothing.package';
import { loadBaseSheet, loadGestureKit } from './avatarAssets';
import { expireOverhead, layoutReaction, showBubble, showReaction } from './bubble';
import { cameraOffset, parseZoomOverride } from './camera';
import { resolveAvatarLook } from './dressUpPreview';
import { createE2EHook, sampleFpsWindow } from './e2eHook';
import { createHuddleLayer, type HuddleRender } from './huddleLayer';
import { createInput } from './input';
import { buildMapLayer } from './mapLayer';
import { mergeInputs } from './mergeInputs';
import { createPlayerView, type PlayerView, poseDirective, setUnderline } from './playerView';
import { createTouchControls } from './touchControls';
import { renderZoneLayer, type ZoneRender } from './zoneLayer';

// The viewport follows the window (Phase 4.5 増分② — no more black margins
// around a fixed 1280x720 canvas). The LOGICAL coordinate system is
// unchanged: physics AABBs, camera math and the e2e snapshot hook all keep
// reading world pixels. What varies is only how many of them are visible
// and at what render resolution — the world container is scaled so the full
// world height (WORLD_HEIGHT, shared by every map) always fits the window,
// and the visible width follows the window's aspect ratio.
const VIEW_H = WORLD_HEIGHT;
const MAX_FRAME = 0.25;

const BG_COLOR = 0x10131b;

/**
 * The per-player display attributes rendered alongside the pose: the name
 * label, plus the status line under the avatar and the zone occupancy tag
 * under that (each `undefined` while default/none). One object rather
 * than adjacent positional strings so a swapped call site cannot compile
 * (the NetHooks precedent), and so the Phase 5 avatar attributes (pose,
 * gear) land as fields instead of an eighth parameter.
 */
export interface PlayerLabel {
  name: string;
  /**
   * The composed status line (statusLabel in @kaede/shared) shown under
   * the avatar, or undefined for the default status (the line hides).
   */
  status: string | undefined;
  /**
   * The composed occupancy tag (groupTagLabel in @kaede/shared: the zone
   * tag, or a huddle's own label), or undefined while in no group.
   */
  zone: string | undefined;
  /**
   * The player's STATE gesture directive (増分①c — 'sit' | 'sleep' |
   * 'dance' from the gesture row), or undefined. Plain strings rather
   * than shared union types on purpose (the fallow type-coupling budget);
   * avatarView narrows at the display boundary. The transient wave never
   * rides a label — it is an event (showLocalWave / showRemoteWave).
   */
  gesture: string | undefined;
  /**
   * The player's availability ('online' | 'away' | 'busy' — the
   * player_status row), or undefined for the default. Drives the derived
   * poses of VISION 体験の核 2: away renders the sleep pose, busy the
   * headphones overlay — no schema of their own (①c 設計).
   */
  availability: string | undefined;
}

/**
 * One update to a player's PlayerLabel, the way the rows change it: a
 * rename (player_name), a status line together with its availability
 * (player_status), a state gesture, or a zone tag. A union rather than
 * Partial<PlayerLabel>, so a rename must carry a name and a status line
 * its availability. Pass one row's fields per patch: the type does not
 * catch a literal that mixes members (a union's excess-property check
 * accepts every member's keys).
 */
export type PlayerLabelPatch =
  | Pick<PlayerLabel, 'name'>
  | Pick<PlayerLabel, 'status' | 'availability'>
  | Pick<PlayerLabel, 'gesture'>
  | Pick<PlayerLabel, 'zone'>;

export interface GameApp {
  destroy(): void;
  /**
   * Swaps the rendered geometry AND the local physics to `map` (Phase 3
   * 複数マップ). Idempotent for the current map. Remote sprites are the
   * caller's business (clearRemotePlayers): which players belong on which
   * map is subscription knowledge, not scene knowledge. The zone layer is
   * the caller's business too (setZones): which zones sit on which map is
   * subscription knowledge, exactly like players.
   */
  setMap(map: WorldMap): void;
  /**
   * Replaces the rendered meeting-room zones (Phase 3 増分② — runtime rows,
   * not map geometry, so a separate call from setMap). The caller passes
   * the current map's zones and re-pushes on zone edits and map switches.
   */
  setZones(zones: readonly ZoneRender[]): void;
  /**
   * Replaces the rendered huddles (Phase 3 増分③ — the setZones sibling).
   * The caller passes the current map's huddles with their member
   * identities; positions resolve per frame from the members' sprites, so
   * the circle follows the avatars between row events.
   */
  setHuddles(huddles: readonly HuddleRender[]): void;
  /**
   * Updates some of the local avatar's display attributes — the name, the
   * status line, the zone tag and the pose inputs (the PlayerLabel fields).
   * Fields left out keep their value. Every field is persistent state, not
   * a timed overhead: it stays until a later patch sets it. Rendered motion
   * overrides the gesture visually (avatarView).
   */
  patchLocalLabel(patch: PlayerLabelPatch): void;
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
  /** Plays the transient wave on the local avatar (増分①c row event). */
  showLocalWave(): void;
  /** Same, on the remote player `id`; a no-op while that player has no sprite. */
  showRemoteWave(id: string): void;
}

/**
 * Shows one player's display attributes on their view: the name, the
 * status and zone lines, the standing-still pose (poseDirective) and the
 * busy headgear. The whole label every time — each part only sets state,
 * so re-applying an unchanged field changes nothing on screen (remote
 * views get it every frame).
 */
function applyLabel(view: PlayerView, label: PlayerLabel): void {
  view.label.text = label.name;
  setUnderline(view.status, label.status);
  setUnderline(view.zone, label.zone);
  view.avatar.play(poseDirective(label.gesture, label.availability));
  view.avatar.setBusy(label.availability === 'busy');
}

/** The rendering resolution: the device pixel ratio, or 1 where unreported. */
function renderResolution(): number {
  return window.devicePixelRatio || 1;
}

/**
 * Dev-only camera magnification (/?zoom=2 — 検品・デモ録画用): vertical-fit
 * rendering leaves no other way to enlarge the avatar on screen. Always 1 in
 * production builds (the DEV gate drops the parser).
 */
function devZoomFactor(): number {
  if (!import.meta.env.DEV) return 1;
  return parseZoomOverride(window.location.search) ?? 1;
}

export async function createGameApp(host: HTMLElement): Promise<GameApp> {
  const devZoom = devZoomFactor();
  const app = new Application();
  // Window-fit canvas: sized to the window in CSS pixels, rendered at the
  // device pixel ratio (autoDensity keeps the CSS size in sync). Resizes are
  // handled by our own listener below rather than resizeTo, so a devicePixelRatio
  // change (browser zoom, monitor move) updates the resolution too.
  await app.init({
    width: window.innerWidth,
    height: window.innerHeight,
    resolution: renderResolution(),
    autoDensity: true,
    background: BG_COLOR,
    antialias: false,
  });
  host.appendChild(app.canvas);

  // The one pose-frame sheet every player view shares (avatarAssets.ts),
  // loaded before any view exists — createGameApp is already the async
  // init path.
  const baseSheet = await loadBaseSheet();
  // Dev-only dress-up preview (the ①b(a) spike): swapped sheet / held item
  // for EVERY view in this tab — selection is per-player only from 増分①e.
  const { sheet: avatarSheet, held: heldItem } = await resolveAvatarLook(baseSheet);
  // The ①c gesture assets, shared by every view like the base sheet. The
  // gesture frames are the BASE outfit's; a dev-preview outfit swap keeps
  // them (the gesture sheets for other outfits are a later factory run).
  const gestureKit = await loadGestureKit();

  const world = new Container();
  app.stage.addChild(world);
  // The map being simulated AND rendered — swapped whole by setMap. The
  // default map is only the pre-session placeholder; the net stack sets the
  // authoritative map when the session wires up.
  let currentMap: WorldMap = mapFor(DEFAULT_MAP_ID);
  let mapLayer = buildMapLayer(currentMap);
  world.addChild(mapLayer);

  // The meeting-room zones (runtime rows, unlike the code-defined map):
  // one persistent container between the map layer and the player views,
  // whose CONTENTS setZones replaces — so the layer's z-position survives
  // setMap's re-add of the map layer at index 0.
  const zoneLayer = new Container();
  world.addChild(zoneLayer);
  let currentZones: readonly ZoneRender[] = [];

  // The huddles (増分③): same layering rule as zones — behind the player
  // views, whose sprites the circles follow per frame (see huddleLayer.ts).
  const huddleLayerRoot = new Container();
  world.addChild(huddleLayerRoot);

  // The local avatar's display attributes (remote views get theirs whole
  // with every upsertRemotePlayer): the own rows patch them piecemeal
  // (patchLocalLabel) and every patch applies the whole label. 'You' holds
  // the name until the own row brings the real one.
  let localLabel: PlayerLabel = {
    name: 'You',
    status: undefined,
    zone: undefined,
    gesture: undefined,
    availability: undefined,
  };
  const local = createPlayerView(world, localLabel.name, avatarSheet, heldItem, gestureKit);
  const remotes = new Map<string, PlayerView>();

  /** The member sprites a huddle circle anchors on this frame. */
  function huddleMemberPositions(huddle: HuddleRender): { x: number; y: number }[] {
    const positions = [];
    if (huddle.includesLocal) positions.push({ x: local.root.x, y: local.root.y });
    for (const id of huddle.memberIds) {
      const view = remotes.get(id);
      if (view) positions.push({ x: view.root.x, y: view.root.y });
    }
    return positions;
  }

  const huddleLayer = createHuddleLayer(huddleLayerRoot, huddleMemberPositions);

  const input = createInput();

  // Touch overlay: only built on coarse-pointer / touch-capable devices. Added
  // to app.stage (not world) so it stays fixed in screen space, above the world.
  const wantsTouch = window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
  const touch = wantsTouch ? createTouchControls() : undefined;
  if (touch) {
    app.stage.addChild(touch.container);
    touch.layout(app.screen.width, app.screen.height);
  }

  // Window-size follower: the renderer tracks the window (and the current
  // devicePixelRatio), the touch overlay re-anchors to the new corners. The
  // camera needs no notification — renderLocal derives the world scale and
  // the visible logical width from app.screen every frame.
  const onWindowResize = () => {
    app.renderer.resize(window.innerWidth, window.innerHeight, renderResolution());
    touch?.layout(app.screen.width, app.screen.height);
  };
  window.addEventListener('resize', onWindowResize);

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
    curr = stepPlayer(curr, sample, currentMap.collision);
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

    // Vertical-fit zoom: the full world height always fills the window, and
    // the visible logical width follows from the window's aspect ratio. The
    // camera math stays in logical world pixels; only the world container's
    // scale and offset are expressed in screen pixels. devZoom (dev-only
    // /?zoom= override) multiplies the fit for inspection and demo capture.
    const scale = (Math.max(app.screen.height, 1) / VIEW_H) * devZoom;
    const viewW = app.screen.width / scale;
    const viewH = app.screen.height / scale;
    world.scale.set(scale);
    const cam = cameraOffset(
      sx,
      sy,
      viewW,
      viewH,
      currentMap.collision.width,
      currentMap.collision.height,
    );
    world.position.set(cam.x * scale, cam.y * scale);
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

  /**
   * Advances every avatar's walk cycle from where its root is rendered this
   * frame. Runs after every position write (renderLocal, the remote upserts
   * in the onFrame callbacks), so the stride follows the RENDERED motion —
   * the same rule for the predicted local pose and the interpolated remote
   * poses, with no extra synced data (rig.ts).
   */
  function animateAvatars(deltaMS: number): void {
    local.avatar.update(local.root.x, deltaMS);
    for (const view of remotes.values()) view.avatar.update(view.root.x, deltaMS);
  }

  const fpsWindow = { frames: 0, windowStart: performance.now(), fps: 0 };

  app.ticker.add((ticker) => {
    const now = performance.now();
    fpsWindow.fps = sampleFpsWindow(now, fpsWindow);
    for (const cb of frameCbs) cb(now);
    // Simulation is gated until start(): never pre-accumulate before it runs.
    acc = tick < 0 ? 0 : acc + Math.min(ticker.deltaMS / 1000, MAX_FRAME);
    while (acc >= DT) simulateTick();
    renderLocal(ticker.deltaMS);
    animateAvatars(ticker.deltaMS);
    // After renderLocal and the remote upserts (onFrame above): the huddle
    // circles anchor on where the sprites ARE this frame.
    huddleLayer.renderFrame();
    expireOverheads(now);
  });

  const e2eHook = createE2EHook(
    local,
    remotes,
    () => tick,
    () => currentMap.id,
    () => currentZones,
    () => huddleLayer.snapshot(),
    () => fpsWindow.fps,
  );

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
      window.removeEventListener('resize', onWindowResize);
      input.dispose();
      touch?.dispose();
      app.destroy(true, { children: true });
    },
    setMap(map) {
      if (map.id === currentMap.id) return;
      currentMap = map;
      mapLayer.destroy({ children: true });
      mapLayer = buildMapLayer(map);
      world.addChildAt(mapLayer, 0);
    },
    setZones(zones) {
      currentZones = zones;
      renderZoneLayer(zoneLayer, zones);
    },
    setHuddles(huddles) {
      huddleLayer.set(huddles);
    },
    patchLocalLabel(patch) {
      localLabel = { ...localLabel, ...patch };
      applyLabel(local, localLabel);
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
        view = createPlayerView(world, label.name, avatarSheet, heldItem, gestureKit);
        remotes.set(id, view);
      }
      applyLabel(view, label);
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
    showLocalWave: () => local.avatar.wave(),
    showRemoteWave: (id) => withRemoteView(id, (view) => view.avatar.wave()),
  };
}
