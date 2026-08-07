// fallow-ignore-file coverage-gaps -- drives PixiJS against a live WebGL canvas; the logic worth testing is extracted into camera.ts, input.ts, and smoothing.ts, which are unit-tested
import {
  type CollisionMap,
  DEFAULT_MAP_ID,
  DT,
  type E2EHook,
  type E2EPlayerSnapshot,
  type Facing,
  mapFor,
  PLAYER_HALF_H,
  type PlayerState,
  type Portal,
  packInput,
  type ReactionEmoji,
  SPAWN_X,
  SPAWN_Y,
  stepPlayer,
  WORLD_HEIGHT,
  type WorldMap,
} from '@kaede/shared';
import type { Texture } from 'pixi.js';
import { Application, Assets, Container, Graphics, Sprite, Text, TextStyle } from 'pixi.js';
import { correctionOffset, decayOffset, type Vec2 } from '../smoothing.package';
import avatarUrl from './avatar.png';
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
import { createHuddleLayer, type HuddleRender } from './huddleLayer';
import { createInput } from './input';
import { mergeInputs } from './mergeInputs';
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
const SOLID_COLOR = 0x3b4252;
const PLATFORM_COLOR = 0x5e81ac; // one-way platforms: lighter than solid ground
const ROPE_COLOR = 0xd8a657;
const ROPE_WIDTH = 4;
const NAME_STYLE = new TextStyle({ fill: 0xffffff, fontSize: 13, fontFamily: 'sans-serif' });

/**
 * The per-player display attributes rendered alongside the pose: the name
 * label, the status line under the avatar, and the zone occupancy tag
 * under that (each `undefined` while default/none). One object rather
 * than adjacent positional strings so a swapped call site cannot compile
 * (the NetHooks precedent), and so the Phase 5 avatar attributes (pose,
 * gear) land as fields instead of an eighth parameter.
 */
export interface PlayerLabel {
  name: string;
  status: string | undefined;
  /** The composed occupancy tag (zoneTagLabel in @kaede/shared), or undefined. */
  zone: string | undefined;
}

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
  setLocalPlayerName(name: string): void;
  /**
   * Shows `status` (the composed line from statusLabel) under the local
   * avatar, or hides the line when undefined (the default status). Persistent
   * state, not a timed overhead — it stays until the next call.
   */
  setLocalStatus(status: string | undefined): void;
  /**
   * Shows the zone occupancy tag (the composed zoneTagLabel) under the
   * local avatar's status line, or hides it when undefined. Persistent
   * state like the status — it stays until the next call.
   */
  setLocalZone(zone: string | undefined): void;
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
  /**
   * The avatar visual, wrapped in a Container kept at unit scale so the
   * facing flip stays `body.scale.x = facing` — the sprite inside carries
   * the fit-to-size scale, and mixing the two on one node would make the
   * flip erase the fit.
   */
  body: Container;
  label: Text;
  /** The status line under the avatar, hidden while the status is default (setUnderline). */
  status: Text;
  /** The zone occupancy tag under the status line, hidden while in no zone (setUnderline). */
  zone: Text;
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

// The zone occupancy tag (ROADMAP Phase 3 増分②): the status line's twin,
// one slot further down so the two persistent lines never collide.
const ZONE_TAG_STYLE = new TextStyle({ fill: 0x9ccfd8, fontSize: 11, fontFamily: 'sans-serif' });

/**
 * One persistent under-avatar line (the status at PLAYER_HALF_H+4, the
 * zone tag at +20), parked at `y` and hidden until a value arrives.
 */
function createUnderline(style: TextStyle, y: number): Text {
  const line = new Text({ text: '', style });
  line.anchor.set(0.5, 0);
  line.y = y;
  line.visible = false;
  return line;
}

/**
 * A labelled avatar view parented under the world container. The visual is
 * the minimal character sprite (Phase 4 の必達「最低限のアバター」— one
 * AI-generated character, no dress-up), scaled to the physics AABB height
 * and centered on it: the AABB stays the authority for collision and every
 * overlay anchor, and the sprite is only how that box looks. Local and
 * remote players share the one character — the name label and the camera
 * (which follows the local player) are what tell people apart until the
 * Phase 5 dress-up work.
 */
function createPlayerView(world: Container, name: string, texture: Texture): PlayerView {
  const root = new Container();
  const body = new Container();
  const sprite = new Sprite(texture);
  sprite.anchor.set(0.5);
  sprite.scale.set((PLAYER_HALF_H * 2) / texture.height);
  body.addChild(sprite);
  const label = new Text({ text: name, style: NAME_STYLE });
  label.anchor.set(0.5, 1);
  label.y = -PLAYER_HALF_H - 4;
  const status = createUnderline(STATUS_STYLE, PLAYER_HALF_H + 4);
  const zone = createUnderline(ZONE_TAG_STYLE, PLAYER_HALF_H + 20);
  const bubble = createBubble();
  const reaction = createReactionBadge();
  root.addChild(body, label, status, zone, bubble.root, reaction.root);
  world.addChild(root);
  return { root, body, label, status, zone, bubble, reaction };
}

/**
 * Applies one composed persistent line (statusLabel / zoneTagLabel in
 * @kaede/shared, undefined while default) to its Text. Unlike the
 * transient overheads there is no timer: both lines are state, visible
 * until the next row event replaces them.
 */
function setUnderline(line: Text, value: string | undefined): void {
  line.visible = value !== undefined;
  line.text = value ?? '';
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
  return withUnderlineSnapshots(view, snap);
}

/**
 * Folds the persistent under-avatar lines (status, zone tag) into one
 * snapshot. Split from playerSnapshot to keep both uncovered functions
 * under the CRAP budget fallow enforces (the reason playerSnapshot avoids
 * conditional spreads, continued).
 */
function withUnderlineSnapshots(view: PlayerView, snap: E2EPlayerSnapshot): E2EPlayerSnapshot {
  if (view.status.visible) snap.status = view.status.text;
  if (view.zone.visible) snap.zone = view.zone.text;
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
  currentMapId: () => number,
  currentZones: () => readonly ZoneRender[],
  currentHuddles: () => readonly { label: string; closed: boolean; members: number }[],
): E2EHook | undefined {
  if (!import.meta.env.DEV) return undefined;
  return {
    snapshot: () => ({
      tick: currentTick(),
      mapId: currentMapId(),
      local: playerSnapshot(local),
      remotePlayers: [...remotes.values()].map(playerSnapshot),
      zones: currentZones().map((zone) => ({ label: zone.label, closed: zone.closed })),
      huddles: [...currentHuddles()],
    }),
  };
}

const PORTAL_COLOR = 0x7aa2f7;
// The portal's destination and the up-key affordance, hovering over the gate.
const PORTAL_LABEL_STYLE = new TextStyle({
  fill: 0xbdd3ff,
  fontSize: 12,
  fontFamily: 'sans-serif',
});

/**
 * One portal's visuals: the glowing gate over its trigger area and the
 * destination label (with the up-key affordance) above it.
 */
function drawPortal(layer: Container, portal: Portal): void {
  const { rect } = portal;
  const gate = new Graphics()
    .ellipse(rect.x + rect.w / 2, rect.y + rect.h / 2, rect.w / 2, rect.h / 2)
    .fill({ color: PORTAL_COLOR, alpha: 0.35 })
    .ellipse(rect.x + rect.w / 2, rect.y + rect.h / 2, rect.w / 3, rect.h / 2.6)
    .fill({ color: PORTAL_COLOR, alpha: 0.5 });
  const label = new Text({ text: `↑ ${portal.label}`, style: PORTAL_LABEL_STYLE });
  label.anchor.set(0.5, 1);
  label.position.set(rect.x + rect.w / 2, rect.y - 6);
  layer.addChild(gate, label);
}

/**
 * The collision geometry as one Graphics: ropes hang behind everything;
 * platforms and the ground slab draw on top of them.
 */
function drawCollision(collision: CollisionMap): Graphics {
  const gfx = new Graphics();
  for (const r of collision.ropes) {
    // Visual span: rope.top down to rope.bottom + PLAYER_HALF_H (the lower end
    // rests on a floor, while rope.bottom bounds the climbing player's center).
    gfx
      .rect(r.x - ROPE_WIDTH / 2, r.top, ROPE_WIDTH, r.bottom + PLAYER_HALF_H - r.top)
      .fill(ROPE_COLOR);
  }
  for (const s of collision.solids) gfx.rect(s.x, s.y, s.w, s.h).fill(SOLID_COLOR);
  for (const p of collision.platforms) gfx.rect(p.x, p.y, p.w, p.h).fill(PLATFORM_COLOR);
  return gfx;
}

/**
 * The static map visuals as one Container: the collision geometry with the
 * portals glowing on top. Added to the world before any player view, so
 * the whole map renders behind players — and rebuilt whole by setMap, so a
 * map switch cannot leak the previous map's shapes.
 */
function buildMapLayer(map: WorldMap): Container {
  const layer = new Container();
  layer.addChild(drawCollision(map.collision));
  for (const portal of map.portals) drawPortal(layer, portal);
  return layer;
}

/** The rendering resolution: the device pixel ratio, or 1 where unreported. */
function renderResolution(): number {
  return window.devicePixelRatio || 1;
}

export async function createGameApp(host: HTMLElement): Promise<GameApp> {
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

  // The one avatar texture every player view shares (bundled by Vite, so the
  // hashed URL busts caches with the asset). Loaded before any view exists —
  // createGameApp is already the async init path.
  const avatarTexture: Texture = await Assets.load(avatarUrl);

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

  const local = createPlayerView(world, 'You', avatarTexture);
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
    // scale and offset are expressed in screen pixels.
    const scale = Math.max(app.screen.height, 1) / VIEW_H;
    const viewW = app.screen.width / scale;
    world.scale.set(scale);
    const cam = cameraOffset(
      sx,
      sy,
      viewW,
      VIEW_H,
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

  app.ticker.add((ticker) => {
    const now = performance.now();
    for (const cb of frameCbs) cb(now);
    // Simulation is gated until start(): never pre-accumulate before it runs.
    acc = tick < 0 ? 0 : acc + Math.min(ticker.deltaMS / 1000, MAX_FRAME);
    while (acc >= DT) simulateTick();
    renderLocal(ticker.deltaMS);
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
    setLocalPlayerName(name) {
      local.label.text = name;
    },
    setLocalStatus(status) {
      setUnderline(local.status, status);
    },
    setLocalZone(zone) {
      setUnderline(local.zone, zone);
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
        view = createPlayerView(world, label.name, avatarTexture);
        remotes.set(id, view);
      }
      view.label.text = label.name;
      setUnderline(view.status, label.status);
      setUnderline(view.zone, label.zone);
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
