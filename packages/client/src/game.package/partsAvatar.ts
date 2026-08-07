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
// Far-limb tint: same texture, pushed back by mild dimming — strong or
// bluish tints read as a detached gray blob at display size, so keep the
// skin recognizably skin.
const FAR_TINT = 0xc9cbd4;

/**
 * One part's placement in the character blueprint: which texture it uses,
 * the joint it pivots around (anchor, in texture fractions) and where that
 * joint sits on the body (logical px, physics-AABB-center origin), which
 * pose channel rotates it, and whether it is a dimmed far limb.
 */
interface PartSpec {
  texture: keyof AvatarPartTextures;
  anchor: { x: number; y: number };
  joint: { x: number; y: number };
  pose: keyof Omit<RigPose, 'bob'> | undefined;
  far: boolean;
}

// The rig blueprint, ordered BACK to FRONT — the chibi stacking where the
// far limbs hide behind the torso, the near limbs ride on it, and the
// oversized head draws over everything (the shoulder seams tuck under the
// chin instead of floating beside the face). Joints sit in LOGICAL px
// relative to the physics-AABB center (0,0); the AABB (32x48: y -24..+24)
// stays the authority for collision and every overlay anchor — the rig
// only decides how that box looks. Limb anchors sit slightly inside the
// top edge (the joint is inside the sleeve/hip, not at the very tip);
// the head pivot sits near its bottom so the hair reaches the AABB top
// (-24) and the chin overlaps the torso. Dress-up (Phase 5 後半) adds
// clothes/hair as extra entries on the same joints.
const BLUEPRINT: readonly PartSpec[] = [
  {
    texture: 'arm',
    anchor: { x: 0.5, y: 0.12 },
    joint: { x: -5.5, y: 6.5 },
    pose: 'armFar',
    far: true,
  },
  {
    texture: 'leg',
    anchor: { x: 0.5, y: 0.12 },
    joint: { x: -3, y: 14.8 },
    pose: 'legFar',
    far: true,
  },
  {
    texture: 'torso',
    anchor: { x: 0.5, y: 0 },
    joint: { x: 0, y: 3 },
    pose: undefined,
    far: false,
  },
  {
    texture: 'leg',
    anchor: { x: 0.5, y: 0.12 },
    joint: { x: 3, y: 14.8 },
    pose: 'legNear',
    far: false,
  },
  {
    texture: 'arm',
    anchor: { x: 0.5, y: 0.12 },
    joint: { x: 5.5, y: 6.5 },
    pose: 'armNear',
    far: false,
  },
  { texture: 'head', anchor: { x: 0.5, y: 0.9 }, joint: { x: 0, y: 3 }, pose: 'head', far: false },
];

/** One blueprint part as a sprite pivoting on its joint. */
function partSprite(tex: AvatarPartTextures, spec: PartSpec): Sprite {
  const sprite = new Sprite(tex[spec.texture]);
  sprite.anchor.set(spec.anchor.x, spec.anchor.y);
  sprite.scale.set(PART_SCALE);
  sprite.position.set(spec.joint.x, spec.joint.y);
  if (spec.far) sprite.tint = FAR_TINT;
  return sprite;
}

/**
 * Builds the parts-split figure under `body` (the unit-scale container
 * whose scale.x carries the facing flip — unchanged from the one-sprite
 * era) by instantiating the blueprint, and returns the per-frame poser.
 */
export function buildPartsAvatar(body: Container, tex: AvatarPartTextures): PartsAvatar {
  const figure = new Container();
  const jointed: [Sprite, keyof Omit<RigPose, 'bob'>][] = [];
  for (const spec of BLUEPRINT) {
    const sprite = partSprite(tex, spec);
    figure.addChild(sprite);
    if (spec.pose !== undefined) jointed.push([sprite, spec.pose]);
  }
  body.addChild(figure);
  return {
    apply(pose) {
      for (const [sprite, channel] of jointed) sprite.rotation = pose[channel];
      figure.y = pose.bob;
    },
  };
}
