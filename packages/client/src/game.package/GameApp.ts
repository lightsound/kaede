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
import { Application, Assets, Container, Graphics, Text, TextStyle } from 'pixi.js';
import { correctionOffset, decayOffset, type Vec2 } from '../smoothing.package';
import avatarManifest from './avatar/manifest.json';
import standUrl from './avatar/stand.png';
import walkAUrl from './avatar/walk-a.png';
import walkBUrl from './avatar/walk-b.png';
import walkCUrl from './avatar/walk-c.png';
import walkDUrl from './avatar/walk-d.png';
import danceAUrl from './avatar-gestures/dance-a.png';
import danceBUrl from './avatar-gestures/dance-b.png';
import danceCUrl from './avatar-gestures/dance-c.png';
import danceDUrl from './avatar-gestures/dance-d.png';
import danceEUrl from './avatar-gestures/dance-e.png';
import danceFUrl from './avatar-gestures/dance-f.png';
import danceGUrl from './avatar-gestures/dance-g.png';
import danceHUrl from './avatar-gestures/dance-h.png';
import gestureManifest from './avatar-gestures/manifest.json';
import sitUrl from './avatar-gestures/sit.png';
import sleepUrl from './avatar-gestures/sleep.png';
import waveUrl from './avatar-gestures/wave.png';
import {
  type AvatarSheetTextures,
  type AvatarView,
  createAvatarView,
  type GestureKit,
  type GestureSheetTextures,
  type HeadgearDisplay,
  type HeldItemDisplay,
} from './avatarView';
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
import { cameraOffset, parseZoomOverride } from './camera';
import { createHuddleLayer, type HuddleRender } from './huddleLayer';
import { createInput } from './input';
import headphonesUrl from './items/headphones/headphones.png';
import headphonesManifest from './items/headphones/manifest.json';
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
 * The standing-still pose an avatar should hold: the explicit gesture
 * outranks the status-derived sleep (the ①c priority rule; rendered
 * motion outranks both, inside avatarView).
 */
function poseDirective(
  gesture: string | undefined,
  availability: string | undefined,
): string | undefined {
  return gesture ?? (availability === 'away' ? 'sleep' : undefined);
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
  /**
   * Sets the local avatar's state-gesture directive (増分①c — the gesture
   * row's value, undefined when the row is gone). Persistent like the
   * status lines; rendered motion overrides it visually (avatarView).
   */
  setLocalGesture(gesture: string | undefined): void;
  /**
   * Sets the local availability ('online' | 'away' | 'busy') for the
   * derived poses: away = sleep pose, busy = headphones overlay. The
   * composed status LINE stays setLocalStatus's business.
   */
  setLocalAvailability(availability: string | undefined): void;
  /** Plays the transient wave on the local avatar (増分①c row event). */
  showLocalWave(): void;
  /** Same, on the remote player `id`; a no-op while that player has no sprite. */
  showRemoteWave(id: string): void;
}

interface PlayerView {
  root: Container;
  /**
   * The avatar visual, wrapped in a Container kept at unit scale so the
   * facing flip stays `body.scale.x = facing` — the sprite inside carries
   * its own scale and ground anchor, and mixing the two on one node would
   * make the flip erase them.
   */
  body: Container;
  /** The pose-frame avatar inside `body` (Phase 5 増分①a); animated every frame. */
  avatar: AvatarView;
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
 * the pose-frame avatar (Phase 5 増分①a — one AI-generated character as a
 * stand + walk pose sheet, frame-swapped by avatarView.ts), grounded on the
 * physics AABB: the AABB stays the authority for collision and every
 * overlay anchor, and the frames are only how that box looks. Local and
 * remote players share the one character — the name label and the camera
 * (which follows the local player) are what tell people apart until the
 * dress-up increments.
 */
function createPlayerView(
  world: Container,
  name: string,
  sheet: AvatarSheetTextures,
  held?: HeldItemDisplay,
  kit?: GestureKit,
): PlayerView {
  const root = new Container();
  const body = new Container();
  const avatar = createAvatarView(body, sheet, held, kit);
  const label = new Text({ text: name, style: NAME_STYLE });
  label.anchor.set(0.5, 1);
  label.y = -PLAYER_HALF_H - 4;
  const status = createUnderline(STATUS_STYLE, PLAYER_HALF_H + 4);
  const zone = createUnderline(ZONE_TAG_STYLE, PLAYER_HALF_H + 20);
  const bubble = createBubble();
  const reaction = createReactionBadge();
  root.addChild(body, label, status, zone, bubble.root, reaction.root);
  world.addChild(root);
  return { root, body, avatar, label, status, zone, bubble, reaction };
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
  const snap: E2EPlayerSnapshot = {
    x: view.root.x,
    y: view.root.y,
    name: view.label.text,
    pose: view.avatar.pose(),
  };
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

/**
 * Dev-only camera magnification (/?zoom=2 — 検品・デモ録画用): vertical-fit
 * rendering leaves no other way to enlarge the avatar on screen. Always 1 in
 * production builds (the DEV gate drops the parser).
 */
function devZoomFactor(): number {
  if (!import.meta.env.DEV) return 1;
  return parseZoomOverride(window.location.search) ?? 1;
}

/**
 * What the dev-only dress-up preview swaps in (ROADMAP ①b 着手順⑵ — the
 * layer-composition verification spike): an outfit-swapped pose sheet
 * and/or a held item pinned to the hand anchors. 増分①e replaces this with
 * real selection UI + persistence; until then the preview exists so the
 * generated assets can be verified walking in the actual game.
 */
interface DressUpPreview {
  sheet?: AvatarSheetTextures;
  held?: HeldItemDisplay;
}

/**
 * Loads the ①c gesture assets every player view shares: the gesture pose
 * sheet (avatar.boy-basic-gestures) and the busy headgear with its
 * per-pose neck anchors — the base manifest's for the walk poses, the
 * gesture manifest's for the gesture poses (the base wins the shared
 * `stand`: it is the frame actually rendered). Bundled statically like the
 * base sheet: gestures are a core feature on every avatar, not a preview.
 */
async function loadGestureKit(): Promise<GestureKit> {
  const [sit, sleep, wave, a, b, c, d, e, f, g, h, headphones] = await Promise.all(
    [
      sitUrl,
      sleepUrl,
      waveUrl,
      danceAUrl,
      danceBUrl,
      danceCUrl,
      danceDUrl,
      danceEUrl,
      danceFUrl,
      danceGUrl,
      danceHUrl,
      headphonesUrl,
    ].map((url) => Assets.load(url)),
  );
  const sheet: GestureSheetTextures = {
    sit,
    sleep,
    wave,
    'dance-a': a,
    'dance-b': b,
    'dance-c': c,
    'dance-d': d,
    'dance-e': e,
    'dance-f': f,
    'dance-g': g,
    'dance-h': h,
  };
  const necks: Record<string, readonly number[]> = {};
  for (const [pose, meta] of Object.entries(gestureManifest.poses)) {
    necks[pose] = meta.anchors.neck;
  }
  for (const [pose, meta] of Object.entries(avatarManifest.poses)) {
    necks[pose] = meta.anchors.neck;
  }
  const headgear: HeadgearDisplay = {
    texture: headphones,
    grip: headphonesManifest.frame.anchors.grip,
    necks,
  };
  return { sheet, headgear };
}

/** Builds one pose sheet from its five loaded frame modules, in pose order. */
async function sheetFromModules(mods: { default: string }[]): Promise<AvatarSheetTextures> {
  const [stand, walkA, walkB, walkC, walkD] = await Promise.all(
    mods.map((m) => Assets.load(m.default)),
  );
  return { stand, 'walk-a': walkA, 'walk-b': walkB, 'walk-c': walkC, 'walk-d': walkD };
}

/** The red-hoodie outfit sheet (avatar.boy-basic-red), loaded on demand. */
async function loadRedSheet(): Promise<AvatarSheetTextures> {
  return sheetFromModules(
    await Promise.all([
      import('./avatar-red/stand.png'),
      import('./avatar-red/walk-a.png'),
      import('./avatar-red/walk-b.png'),
      import('./avatar-red/walk-c.png'),
      import('./avatar-red/walk-d.png'),
    ]),
  );
}

/**
 * How an item is carried (its manifest's carryStyle — owner direction
 * 2026-08-12): light items ride the one-hand carry sheets, heavy/bulky
 * ones the two-arm front carry. Which pose sheet a body wears and whether
 * an item can ride it stay one decision (the ①b(a) verdict); the style
 * only picks WHICH carry family.
 */
type CarryStyle = 'light' | 'heavy';

/**
 * The carry-pose sheet variants: a stable hand anchor through the whole
 * stride — the ①b(a) verdict that a statically anchored item cannot ride
 * the swing-walk sheets (see HeldItemDisplay). Vite needs literal import()
 * paths, hence the four-thunk table.
 */
const CARRY_SHEET_LOADERS: Record<string, () => Promise<{ default: string }[]>> = {
  'heavy-base': () =>
    Promise.all([
      import('./avatar-carry/stand.png'),
      import('./avatar-carry/walk-a.png'),
      import('./avatar-carry/walk-b.png'),
      import('./avatar-carry/walk-c.png'),
      import('./avatar-carry/walk-d.png'),
    ]),
  'heavy-red': () =>
    Promise.all([
      import('./avatar-red-carry/stand.png'),
      import('./avatar-red-carry/walk-a.png'),
      import('./avatar-red-carry/walk-b.png'),
      import('./avatar-red-carry/walk-c.png'),
      import('./avatar-red-carry/walk-d.png'),
    ]),
  'light-base': () =>
    Promise.all([
      import('./avatar-carry-light/stand.png'),
      import('./avatar-carry-light/walk-a.png'),
      import('./avatar-carry-light/walk-b.png'),
      import('./avatar-carry-light/walk-c.png'),
      import('./avatar-carry-light/walk-d.png'),
    ]),
  'light-red': () =>
    Promise.all([
      import('./avatar-red-carry-light/stand.png'),
      import('./avatar-red-carry-light/walk-a.png'),
      import('./avatar-red-carry-light/walk-b.png'),
      import('./avatar-red-carry-light/walk-c.png'),
      import('./avatar-red-carry-light/walk-d.png'),
    ]),
};

/** The carry sheets' manifest + hand cutout, keyed like CARRY_SHEET_LOADERS. */
const CARRY_KIT_LOADERS = {
  'heavy-base': () =>
    Promise.all([import('./avatar-carry/manifest.json'), import('./avatar-carry/hand.png')]),
  'heavy-red': () =>
    Promise.all([
      import('./avatar-red-carry/manifest.json'),
      import('./avatar-red-carry/hand.png'),
    ]),
  'light-base': () =>
    Promise.all([
      import('./avatar-carry-light/manifest.json'),
      import('./avatar-carry-light/hand.png'),
    ]),
  'light-red': () =>
    Promise.all([
      import('./avatar-red-carry-light/manifest.json'),
      import('./avatar-red-carry-light/hand.png'),
    ]),
};

async function loadCarrySheet(style: CarryStyle, redOutfit: boolean): Promise<AvatarSheetTextures> {
  return sheetFromModules(await CARRY_SHEET_LOADERS[`${style}-${redOutfit ? 'red' : 'base'}`]());
}

/**
 * The held-item catalog of the dev preview (the ①b(a) genericity check:
 * one resting rule, five item classes — compact, flat, long-shafted,
 * plush, and a spear taller than the character). Thunks so production
 * DCE drops the chunks with the rest of the preview.
 */
const HELD_ITEM_LOADERS = {
  mug: () =>
    Promise.all([
      import('./items/coffee-mug/manifest.json'),
      import('./items/coffee-mug/coffee-mug.png'),
    ]),
  notebook: () =>
    Promise.all([
      import('./items/notebook/manifest.json'),
      import('./items/notebook/notebook.png'),
    ]),
  umbrella: () =>
    Promise.all([
      import('./items/umbrella/manifest.json'),
      import('./items/umbrella/umbrella.png'),
    ]),
  plush: () =>
    Promise.all([
      import('./items/plush-bear/manifest.json'),
      import('./items/plush-bear/plush-bear.png'),
    ]),
  spear: () =>
    Promise.all([import('./items/spear/manifest.json'), import('./items/spear/spear.png')]),
};

/**
 * One held item, manifest-driven: the item's grip point comes from its own
 * manifest, and the per-pose hand anchors from the manifest of the carry
 * sheet being worn — the anchors are frame coordinates, so they must match
 * the frames actually rendered.
 */
async function loadHeldItem(
  loader: (typeof HELD_ITEM_LOADERS)[keyof typeof HELD_ITEM_LOADERS],
  style: CarryStyle,
  redOutfit: boolean,
): Promise<HeldItemDisplay> {
  const [[itemManifest, itemUrl], [bodyManifest, handUrl]] = await Promise.all([
    loader(),
    CARRY_KIT_LOADERS[`${style}-${redOutfit ? 'red' : 'base'}`](),
  ]);
  const [texture, handTexture] = await Promise.all([
    Assets.load(itemUrl.default),
    Assets.load(handUrl.default),
  ]);
  const poses = bodyManifest.default.poses;
  return {
    texture,
    grip: itemManifest.default.frame.anchors.grip,
    hands: {
      stand: poses.stand.anchors.hand,
      'walk-a': poses['walk-a'].anchors.hand,
      'walk-b': poses['walk-b'].anchors.hand,
      'walk-c': poses['walk-c'].anchors.hand,
      'walk-d': poses['walk-d'].anchors.hand,
    },
    hand: { texture: handTexture, grip: bodyManifest.default.handLayer.anchors.grip },
  };
}

/**
 * Reads the dev-only preview selection from the URL (?outfit=red,
 * ?held=mug|notebook|umbrella|plush|spear). Dev builds only — the callers
 * gate on import.meta.env.DEV, so production bundles drop this code and
 * the preview assets with it. Holding an item swaps the whole body sheet
 * to the carry variant: which pose sheet a body wears and whether an item
 * can ride it are one decision (the ①b(a) verdict), not two independent
 * toggles.
 */
/**
 * The carrying look for one held item: the item's own manifest names its
 * carry style (light = one-hand, heavy = two-arm front), and the body
 * swaps to that carry family. Split from loadDressUpPreview to keep both
 * under the CRAP complexity budget (the createGameApp precedent).
 */
async function loadHeldPreview(
  loader: (typeof HELD_ITEM_LOADERS)[keyof typeof HELD_ITEM_LOADERS],
  redOutfit: boolean,
): Promise<DressUpPreview> {
  const [itemManifest] = await loader();
  const style: CarryStyle = itemManifest.default.carryStyle === 'light' ? 'light' : 'heavy';
  return {
    sheet: await loadCarrySheet(style, redOutfit),
    held: await loadHeldItem(loader, style, redOutfit),
  };
}

async function loadDressUpPreview(): Promise<DressUpPreview> {
  const params = new URLSearchParams(window.location.search);
  const redOutfit = params.get('outfit') === 'red';
  const held = params.get('held');
  const loader = held ? HELD_ITEM_LOADERS[held as keyof typeof HELD_ITEM_LOADERS] : undefined;
  if (loader) return loadHeldPreview(loader, redOutfit);
  if (redOutfit) return { sheet: await loadRedSheet() };
  return {};
}

/**
 * The avatar look every player view in this tab renders: the base sheet,
 * unless the dev-only dress-up preview (the ①b(a) spike) swaps in an
 * outfit sheet and/or a held item. A helper rather than inline branches so
 * createGameApp stays under the CRAP complexity budget.
 */
async function resolveAvatarLook(
  base: AvatarSheetTextures,
): Promise<{ sheet: AvatarSheetTextures; held?: HeldItemDisplay }> {
  const preview: DressUpPreview = import.meta.env.DEV ? await loadDressUpPreview() : {};
  return { sheet: preview.sheet ?? base, held: preview.held };
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

  // The one pose-frame sheet every player view shares (bundled by Vite, so
  // the hashed URLs bust caches with the assets). Loaded before any view
  // exists — createGameApp is already the async init path.
  const [stand, walkA, walkB, walkC, walkD] = await Promise.all(
    [standUrl, walkAUrl, walkBUrl, walkCUrl, walkDUrl].map((url) => Assets.load(url)),
  );
  const baseSheet: AvatarSheetTextures = {
    stand,
    'walk-a': walkA,
    'walk-b': walkB,
    'walk-c': walkC,
    'walk-d': walkD,
  };
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

  const local = createPlayerView(world, 'You', avatarSheet, heldItem, gestureKit);
  const remotes = new Map<string, PlayerView>();
  // The local avatar's pose inputs (the remote ones ride PlayerLabel):
  // the state gesture from the own gesture row, the availability from the
  // own status row — combined by poseDirective on every change.
  let localGesture: string | undefined;
  let localAvailability: string | undefined;

  function applyLocalPose(): void {
    local.avatar.play(poseDirective(localGesture, localAvailability));
    local.avatar.setBusy(localAvailability === 'busy');
  }

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

  app.ticker.add((ticker) => {
    const now = performance.now();
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
        view = createPlayerView(world, label.name, avatarSheet, heldItem, gestureKit);
        remotes.set(id, view);
      }
      view.label.text = label.name;
      setUnderline(view.status, label.status);
      setUnderline(view.zone, label.zone);
      view.avatar.play(poseDirective(label.gesture, label.availability));
      view.avatar.setBusy(label.availability === 'busy');
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
    setLocalGesture(gesture) {
      localGesture = gesture;
      applyLocalPose();
    },
    setLocalAvailability(availability) {
      localAvailability = availability;
      applyLocalPose();
    },
    showLocalWave: () => local.avatar.wave(),
    showRemoteWave: (id) => withRemoteView(id, (view) => view.avatar.wave()),
  };
}
