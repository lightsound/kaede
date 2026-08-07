// fallow-ignore-file coverage-gaps -- assembles PixiJS sprites into the parts-split avatar; the animation math worth testing lives in rig.ts, which is unit-tested
import { Container, Sprite, type Texture } from 'pixi.js';
import type { RigPose } from './rig';

/**
 * The four part textures of one character (Phase 5 parts-split rig). The
 * arm and leg textures are shared by the near and far limbs — the far
 * copy is tinted darker for depth instead of shipping a second image.
 */
export interface AvatarPartTextures {
  head: Texture;
  torso: Texture;
  arm: Texture;
  leg: Texture;
}

/** A built parts avatar: apply() poses the joints for the current frame. */
export interface PartsAvatar {
  apply(pose: RigPose): void;
}

// Part assets ship at 2x the logical display resolution (the Phase 4
// avatar precedent), so every part sprite renders at half scale.
const PART_SCALE = 0.5;
// Far-limb tint: same texture, pushed back by dimming.
const FAR_TINT = 0xb0b6c4;

// Rig layout in LOGICAL px relative to the physics-AABB center (0,0);
// the AABB (32x48: y -24..+24) stays the authority for collision and
// every overlay anchor — the rig only decides how that box looks.
// Anchors sit on the joints so rotation swings the limb around it.
const NECK = { x: 0, y: 3 };
const SHOULDER_X = 5.5;
const SHOULDER_Y = 6;
const HIP_X = 3;
const HIP_Y = 15.5;
// Head pivot near its bottom edge: the hair reaches the AABB top (-24)
// and the chin overlaps the torso, chibi-style.
const HEAD_ANCHOR_Y = 0.9;
// Limb pivots slightly inside the top edge (the joint is inside the
// sleeve/hip, not at the very tip of the image).
const LIMB_ANCHOR_Y = 0.14;

/** One part sprite at its joint, at half scale (2x asset), optionally dimmed. */
function partSprite(tex: Texture, anchorY: number, x: number, y: number, far: boolean): Sprite {
  const sprite = new Sprite(tex);
  sprite.anchor.set(0.5, anchorY);
  sprite.scale.set(PART_SCALE);
  sprite.position.set(x, y);
  if (far) sprite.tint = FAR_TINT;
  return sprite;
}

/**
 * Builds the parts-split figure under `body` (the unit-scale container
 * whose scale.x carries the facing flip — unchanged from the one-sprite
 * era). Layer order back-to-front: far arm, far leg, torso, near leg,
 * head, near arm — the MapleStory-style stacking where clothes sit on the
 * torso and hair on the head land as extra layers on the same joints.
 */
export function buildPartsAvatar(body: Container, tex: AvatarPartTextures): PartsAvatar {
  const figure = new Container();
  const armFar = partSprite(tex.arm, LIMB_ANCHOR_Y, -SHOULDER_X, SHOULDER_Y, true);
  const legFar = partSprite(tex.leg, LIMB_ANCHOR_Y, -HIP_X, HIP_Y, true);
  const torso = partSprite(tex.torso, 0, 0, NECK.y, false);
  const legNear = partSprite(tex.leg, LIMB_ANCHOR_Y, HIP_X, HIP_Y, false);
  const head = partSprite(tex.head, HEAD_ANCHOR_Y, NECK.x, NECK.y, false);
  const armNear = partSprite(tex.arm, LIMB_ANCHOR_Y, SHOULDER_X, SHOULDER_Y, false);
  figure.addChild(armFar, legFar, torso, legNear, head, armNear);
  body.addChild(figure);
  return {
    apply(pose) {
      legNear.rotation = pose.legNear;
      legFar.rotation = pose.legFar;
      armNear.rotation = pose.armNear;
      armFar.rotation = pose.armFar;
      head.rotation = pose.head;
      figure.y = pose.bob;
    },
  };
}
