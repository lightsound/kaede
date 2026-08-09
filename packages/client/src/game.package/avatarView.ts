// fallow-ignore-file coverage-gaps -- binds PixiJS sprites to the pose-frame sheet; the walk-phase and frame-selection logic lives in rig.ts, which is unit-tested
import { PLAYER_HALF_H } from '@kaede/shared';
import { type Container, Sprite, type Texture } from 'pixi.js';
import { advanceWalk, IDLE_WALK_STATE, selectPose, type WalkState } from './rig';

/**
 * The pose-frame textures of one character (avatar/manifest.json poses —
 * the frames the import line cut from the green-screen sheet). The keys are
 * spelled out rather than derived from rig.ts's AvatarPose so this public
 * signature references no type from another file (the fallow type-coupling
 * budget); the compiler still enforces the correspondence at the indexing
 * site below.
 */
export interface AvatarSheetTextures {
  stand: Texture;
  'walk-a': Texture;
  'walk-b': Texture;
  'walk-c': Texture;
  'walk-d': Texture;
}

/**
 * A held item composited onto the avatar's hand anchor (avatar-rig.md §2 —
 * the held-item layer). All coordinates are pixels in the source frames
 * (2x display resolution, origin top-left, straight from the manifests):
 * `grip` is the point in the item frame that lands on the hand anchor, and
 * `hands` are the per-pose hand anchors. The keys mirror AvatarSheetTextures
 * so held items and pose frames can never disagree about which poses exist.
 *
 * The caller pairs a held item with a CARRY-pose sheet variant (both arms
 * hang still — avatar.boy-basic-carry), the ①b(a) spike's measured
 * conclusion after owner review: on the standard walk sheets the
 * exaggerated arm swing (the very thing that makes the leg alternation
 * readable, ①b(c)) leaves both fists prominently empty, so a statically
 * anchored item reads as floating wherever it is pinned — anchor
 * precision cannot fix that. The item itself is a BARE sprite that RESTS
 * ON the sheet's drawn hand, MapleStory-style (owner direction
 * 2026-08-09): its grip point (bottom-center for resting items, the
 * measured shaft point for long ones) lands on the hand anchor and the
 * drawn mitten peeks out beneath — one rule for every item class, no
 * per-item baked hands (rejected: too realistic for the chibi style and
 * not generic).
 */
export interface HeldItemDisplay {
  texture: Texture;
  grip: readonly number[];
  hands: { readonly [P in keyof AvatarSheetTextures]: readonly number[] };
}

/**
 * The thin rendering boundary of docs/avatar-rig.md §4: the game side hands
 * over rendered positions and frame times, and how those become a posed
 * figure (today a pose-frame swap; a future DP-A could swap in Spine) stays
 * behind this interface. Gestures (増分①c) will add a play(motion) here;
 * dress-up (増分①d) a setSkin.
 */
export interface AvatarView {
  /**
   * Advances the walk cycle from where the avatar is rendered this frame
   * (`xPx` the root's logical world x, `dtMs` the frame time) and shows the
   * resulting pose frame. The first call only records the position.
   */
  update(xPx: number, dtMs: number): void;
}

// Frame assets ship at 2x the logical display resolution (the Phase 4
// avatar precedent, docs/asset-pipeline.md §2).
const ASSET_SCALE = 0.5;

/**
 * The held item as a sprite whose origin is its grip point: positioning it
 * at a pose's hand anchor is then a single coordinate conversion per frame
 * (see placeHeldItem). Added to `body` after the avatar sprite, so the
 * item draws in front of the body with the drawn hand peeking beneath it —
 * the carry sheets keep the holding hand on the viewer side in every
 * pose, so one z-position suffices; no per-pose z or rotation field
 * earned its way into the manifest (verified across five item classes,
 * spear included).
 */
function createHeldItemSprite(item: HeldItemDisplay): Sprite {
  const sprite = new Sprite(item.texture);
  const [gripX, gripY] = item.grip;
  sprite.anchor.set((gripX ?? 0) / item.texture.width, (gripY ?? 0) / item.texture.height);
  sprite.scale.set(ASSET_SCALE);
  return sprite;
}

/**
 * Parks the held item's grip on the pose's hand anchor. The anchor is in
 * frame pixels (2x, origin top-left); the avatar sprite renders that frame
 * bottom-centered at the AABB's bottom edge at ASSET_SCALE, so the same
 * transform maps the anchor into body-local coordinates.
 */
function placeHeldItem(item: Sprite, frame: Texture, hand: readonly number[]): void {
  const [handX, handY] = hand;
  item.x = ((handX ?? 0) - frame.width / 2) * ASSET_SCALE;
  item.y = PLAYER_HALF_H - (frame.height - (handY ?? 0)) * ASSET_SCALE;
}

/**
 * Builds the pose-frame avatar under `body` (the unit-scale container whose
 * scale.x carries the facing flip — unchanged from the one-sprite era) and
 * returns its per-frame animator. The sprite anchors bottom-center at the
 * physics AABB's bottom edge: the import line aligns every frame's ground
 * baseline to the frame bottom, so each pose stands grounded whatever its
 * trimmed size — the AABB stays the authority for collision and every
 * overlay anchor, and the frames are only how that box looks. A held item
 * (optional) rides the pose's hand anchor and flips with the body.
 */
export function createAvatarView(
  body: Container,
  sheet: AvatarSheetTextures,
  held?: HeldItemDisplay,
): AvatarView {
  const sprite = new Sprite(sheet.stand);
  sprite.anchor.set(0.5, 1);
  sprite.y = PLAYER_HALF_H;
  sprite.scale.set(ASSET_SCALE);
  body.addChild(sprite);

  const item = held ? createHeldItemSprite(held) : undefined;
  if (item) body.addChild(item);

  let walk: WalkState = IDLE_WALK_STATE;
  let lastX: number | undefined;
  return {
    update(xPx, dtMs) {
      const dx = lastX === undefined ? 0 : xPx - lastX;
      lastX = xPx;
      walk = advanceWalk(walk, dx, dtMs);
      const pose = selectPose(walk);
      sprite.texture = sheet[pose];
      if (item && held) placeHeldItem(item, sheet[pose], held.hands[pose]);
    },
  };
}
