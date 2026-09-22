// fallow-ignore-file coverage-gaps -- binds PixiJS sprites to the pose-frame sheet; the walk-phase and frame-selection logic lives in rig.ts, which is unit-tested
import { DANCE_FRAME_MS, PLAYER_HALF_H, WAVE_GESTURE_DURATION_MS } from '@kaede/shared';
import { type Container, Sprite, type Texture } from 'pixi.js';
import { advanceWalk, IDLE_WALK_STATE, selectPose, type WalkState } from './rig';

/** One walk frame: its pose name (walk-a, walk-b, …) and its texture. */
export interface WalkFrameTexture {
  pose: string;
  texture: Texture;
}

/**
 * The pose-frame textures of one character (avatar/manifest.json poses —
 * the frames the import line cut from the green-screen sheet). Walk frames
 * arrive as an ORDERED LIST rather than fixed keys since the A-3
 * densification (2026-08-20): the dense sheets carry 12 frames per stride
 * and the legacy carry-light sheets keep 4 (裁定④ 据え置き), and the walk
 * cadence follows whichever list the sheet declares.
 */
export interface AvatarSheetTextures {
  stand: Texture;
  /** Walk frames in stride order — 12 on dense sheets, 4 on legacy ones. */
  walk: readonly WalkFrameTexture[];
}

/**
 * A held item composited onto the avatar's hand anchor (avatar-rig.md §2 —
 * the held-item layer). All coordinates are pixels in the source frames
 * (4x display resolution, origin top-left, straight from the manifests):
 * `grip` is the point in the item frame that lands on the hand anchor, and
 * `hands` are the per-pose hand anchors. The keys mirror AvatarSheetTextures
 * so held items and pose frames can never disagree about which poses exist.
 *
 * The caller pairs a held item with a CARRY-pose sheet variant (the near
 * arm bent at the elbow, palm up, held still — avatar.boy-basic-carry),
 * the ①b(a) spike's owner-directed spec: on the standard walk sheets the
 * exaggerated arm swing (the very thing that makes the leg alternation
 * readable, ①b(c)) leaves both fists prominently empty, so a statically
 * anchored item reads as floating wherever it is pinned — anchor
 * precision cannot fix that. The item itself is a BARE sprite that RESTS
 * ON the sheet's palm-up hand, MapleStory-style: its grip point
 * (bottom-center for resting items, the measured shaft point for long
 * ones) lands on the hand anchor — one rule for every item class, no
 * per-item baked hands (rejected: too realistic for the chibi style and
 * not generic). The `hand` layer (the sheet's own bare hand/forearm, cut
 * by the import line) renders ON TOP of the item, so the mitten reads as
 * being in front of what it carries — MapleStory's hand-over-item
 * layering, the owner's z rule.
 */
export interface HeldItemDisplay {
  texture: Texture;
  grip: readonly number[];
  /** Per-pose hand anchors, keyed by pose name (from the carry manifest). */
  hands: Readonly<Record<string, readonly number[] | undefined>>;
  /** The carry sheet's hand overlay (manifest handLayer), drawn over the item. */
  hand: { texture: Texture; grip: readonly number[] };
}

/**
 * The gesture pose frames of one character (avatar-gestures/manifest.json —
 * the ①c sheet: floor sit, sleep, wave, and the 8-frame dance loop). Keys
 * spelled out for the AvatarSheetTextures reason (no cross-file type in
 * this public signature — the fallow type-coupling budget).
 */
export interface GestureSheetTextures {
  sit: Texture;
  sleep: Texture;
  wave: Texture;
  'dance-a': Texture;
  'dance-b': Texture;
  'dance-c': Texture;
  'dance-d': Texture;
  'dance-e': Texture;
  'dance-f': Texture;
  'dance-g': Texture;
  'dance-h': Texture;
}

/**
 * The busy-status headgear (取り込み中=ヘッドホン — VISION 体験の核 2),
 * composited onto the current pose's NECK anchor the way held items ride
 * the hand anchor: `grip` is the point in the headgear frame that lands on
 * the anchor, `necks` the per-pose neck anchors (frame pixels, 4x, from
 * the manifests). Poses without a neck entry — and the sleep pose, whose
 * head lies sideways — simply hide the gear.
 */
export interface HeadgearDisplay {
  texture: Texture;
  grip: readonly number[];
  necks: Readonly<Record<string, readonly number[] | undefined>>;
}

/** The ①c gesture assets one avatar view renders with (optional as a unit). */
export interface GestureKit {
  sheet: GestureSheetTextures;
  headgear?: HeadgearDisplay;
}

/**
 * The thin rendering boundary of docs/avatar-rig.md §4: the game side hands
 * over rendered positions, frame times and pose directives, and how those
 * become a posed figure (today a pose-frame swap; a future DP-A could swap
 * in Spine) stays behind this interface. Dress-up (増分①d) adds a setSkin.
 */
export interface AvatarView {
  /**
   * Advances the walk cycle from where the avatar is rendered this frame
   * (`xPx` the root's logical world x, `dtMs` the frame time) and shows the
   * resulting pose frame. The first call only records the position.
   */
  update(xPx: number, dtMs: number): void;
  /**
   * Sets the standing-still pose directive (増分①c): a STATE gesture
   * ('sit' | 'sleep' | 'dance'), or undefined for none. Display priority
   * is rendered motion > wave > this — a walking avatar walks whatever the
   * directive says, which is also what makes the server-side
   * clear-on-movement feel immediate (the delete lands a beat later).
   * Unknown strings read as none (the isReactionEmoji narrowing rule).
   */
  play(gesture: string | undefined): void;
  /** Plays the transient wave for WAVE_GESTURE_DURATION_MS (増分①c). */
  wave(): void;
  /** Shows/hides the busy headgear overlay (取り込み中 — 増分①c). */
  setBusy(busy: boolean): void;
  /** The pose frame currently shown (the e2e snapshot's evidence). */
  pose(): string;
}

// Frame assets ship at 4x the logical display resolution (the factory-v2
// step-1 ruling raising the Phase 4 2x precedent, docs/asset-pipeline.md §2:
// the extra pixels feed Retina/zoom rendering and inspection precision).
const ASSET_SCALE = 0.25;

/**
 * A carried layer as a sprite whose origin is its grip point: positioning
 * it at a pose's hand anchor is then a single coordinate conversion per
 * frame (see placeHeldItem). Used for both the item and the hand overlay;
 * the caller adds them to `body` after the avatar sprite in stacking
 * order body → item → hand, so the item draws in front of the body and
 * the mitten draws in front of the item (verified across five item
 * classes, spear included — no per-pose z or rotation field earned its
 * way into the manifest).
 */
function createGripSprite(texture: Texture, grip: readonly number[]): Sprite {
  const sprite = new Sprite(texture);
  const [gripX, gripY] = grip;
  sprite.anchor.set((gripX ?? 0) / texture.width, (gripY ?? 0) / texture.height);
  sprite.scale.set(ASSET_SCALE);
  return sprite;
}

/**
 * Parks the held item's grip on the pose's hand anchor. The anchor is in
 * frame pixels (4x, origin top-left); the avatar sprite renders that frame
 * bottom-centered at the AABB's bottom edge at ASSET_SCALE, so the same
 * transform maps the anchor into body-local coordinates.
 */
function placeHeldItem(item: Sprite, frame: Texture, hand: readonly number[]): void {
  const [handX, handY] = hand;
  item.x = ((handX ?? 0) - frame.width / 2) * ASSET_SCALE;
  item.y = PLAYER_HALF_H - (frame.height - (handY ?? 0)) * ASSET_SCALE;
}

/** The two carried sprites, stacked item-then-hand (see createGripSprite). */
interface CarriedSprites {
  item: Sprite;
  hand: Sprite;
}

function createCarriedSprites(held: HeldItemDisplay): CarriedSprites {
  return {
    item: createGripSprite(held.texture, held.grip),
    hand: createGripSprite(held.hand.texture, held.hand.grip),
  };
}

/** Parks both carried sprites on the pose's hand anchor. */
function placeCarried(carried: CarriedSprites, frame: Texture, hand: readonly number[]): void {
  placeHeldItem(carried.item, frame, hand);
  placeHeldItem(carried.hand, frame, hand);
}

/** The dance loop's frame keys in play order (100ms each — DANCE_FRAME_MS). */
const DANCE_POSES = [
  'dance-a',
  'dance-b',
  'dance-c',
  'dance-d',
  'dance-e',
  'dance-f',
  'dance-g',
  'dance-h',
] as const;

/** Narrows a row string to a state-gesture directive; anything else is none. */
function stateGestureOf(value: string | undefined): 'sit' | 'sleep' | 'dance' | undefined {
  return value === 'sit' || value === 'sleep' || value === 'dance' ? value : undefined;
}

/** The state gesture's pose frame: the dance cycles on the view clock. */
function gesturePose(gesture: 'sit' | 'sleep' | 'dance' | undefined, clockMs: number): string {
  if (gesture === 'dance') {
    return DANCE_POSES[Math.floor(clockMs / DANCE_FRAME_MS) % DANCE_POSES.length];
  }
  return gesture ?? 'stand';
}

/** The hidden-by-default headgear sprite, when a headgear display exists. */
function createGearSprite(body: Container, headgear?: HeadgearDisplay): Sprite | undefined {
  if (!headgear) return undefined;
  const sprite = createGripSprite(headgear.texture, headgear.grip);
  sprite.visible = false;
  body.addChild(sprite);
  return sprite;
}

/**
 * Builds the pose-frame avatar under `body` (the unit-scale container whose
 * scale.x carries the facing flip — unchanged from the one-sprite era) and
 * returns its per-frame animator. The sprite anchors bottom-center at the
 * physics AABB's bottom edge: the import line aligns every frame's ground
 * baseline to the frame bottom, so each pose stands grounded whatever its
 * trimmed size — the AABB stays the authority for collision and every
 * overlay anchor, and the frames are only how that box looks. A held item
 * (optional) rides the pose's hand anchor and flips with the body; the
 * gesture kit (optional — 増分①c) adds the pose gestures and the busy
 * headgear. Held items hide on gesture poses: their hand anchors are
 * measured on the walk sheets only, and the ①c gestures ship for the base
 * outfit while items pair with the carry sheets (dev preview).
 */
export function createAvatarView(
  body: Container,
  sheet: AvatarSheetTextures,
  held?: HeldItemDisplay,
  kit?: GestureKit,
): AvatarView {
  const sprite = new Sprite(sheet.stand);
  sprite.anchor.set(0.5, 1);
  sprite.y = PLAYER_HALF_H;
  sprite.scale.set(ASSET_SCALE);
  body.addChild(sprite);

  // The sheet's own walk vocabulary: the pose list drives the cadence
  // (selectPose slices the stride by its length) and the texture lookup.
  const walkPoses = sheet.walk.map((frame) => frame.pose);
  const textures = new Map<string, Texture>([
    ['stand', sheet.stand],
    ...sheet.walk.map((frame): [string, Texture] => [frame.pose, frame.texture]),
  ]);

  const carried = held ? createCarriedSprites(held) : undefined;
  if (carried) body.addChild(carried.item, carried.hand);

  const gear = createGearSprite(body, kit?.headgear);

  let walk: WalkState = IDLE_WALK_STATE;
  let lastX: number | undefined;
  // The view's own clock (summed frame times): the dance frame index and
  // the wave expiry both read it, so neither needs wall time.
  let clockMs = 0;
  let waveUntilMs: number | undefined;
  let stateGesture: 'sit' | 'sleep' | 'dance' | undefined;
  let busy = false;
  let shownPose = 'stand';

  /** The standing-still pose: wave > state gesture > stand (idle priority). */
  function idlePose(): string {
    if (waveUntilMs !== undefined && clockMs < waveUntilMs) return 'wave';
    waveUntilMs = undefined;
    return gesturePose(stateGesture, clockMs);
  }

  /** The texture for `pose`, from whichever sheet declares it. */
  function textureOf(pose: string): Texture {
    const base = textures.get(pose);
    return base ?? kit?.sheet[pose as keyof GestureSheetTextures] ?? sheet.stand;
  }

  /** The held item follows poses with measured hand anchors, hides elsewhere. */
  function updateCarried(pose: string, frame: Texture): void {
    if (!carried || !held) return;
    const hands = held.hands[pose];
    carried.item.visible = carried.hand.visible = hands !== undefined;
    if (hands) placeCarried(carried, frame, hands);
  }

  /**
   * The neck anchor the busy headgear rides on `pose`, or undefined while
   * it must hide: not busy, no measured neck, or the sleep pose (the head
   * lies sideways; an upright overlay would float).
   */
  function headgearNeck(pose: string): readonly number[] | undefined {
    if (!busy || pose === 'sleep') return undefined;
    return kit?.headgear?.necks[pose];
  }

  /** Parks the busy headgear on the current pose's neck anchor. */
  function placeHeadgear(pose: string, frame: Texture): void {
    if (!gear) return;
    const neck = headgearNeck(pose);
    gear.visible = neck !== undefined;
    if (neck) placeHeldItem(gear, frame, neck);
  }

  return {
    update(xPx, dtMs) {
      const dx = lastX === undefined ? 0 : xPx - lastX;
      lastX = xPx;
      clockMs += Math.max(0, dtMs);
      walk = advanceWalk(walk, dx, dtMs);
      const walkPose = selectPose(walk, walkPoses);
      shownPose = walkPose === 'stand' && kit ? idlePose() : walkPose;
      const frame = textureOf(shownPose);
      sprite.texture = frame;
      updateCarried(shownPose, frame);
      placeHeadgear(shownPose, frame);
    },
    play(gesture) {
      stateGesture = stateGestureOf(gesture);
    },
    wave() {
      waveUntilMs = clockMs + WAVE_GESTURE_DURATION_MS;
    },
    setBusy(value) {
      busy = value;
    },
    pose() {
      return shownPose;
    },
  };
}
