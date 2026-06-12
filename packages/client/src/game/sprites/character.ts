import { PLAYER_HALF_H, PLAYER_HALF_W } from '@maple/shared';
import { Container, Graphics } from 'pixi.js';
import { createOscillator, createPhase } from './oscillator';

/**
 * Procedural player rig: a Container holding Graphics parts (head, torso, two
 * arms, two legs) sized so the whole body fits the physics AABB (half extents
 * PLAYER_HALF_W/H). The rig ORIGIN is the AABB center — GameApp positions the
 * root there and parents the name label / speech bubble to it, so the origin
 * must not move. Facing is applied by the caller mirroring `body.scale.x`
 * (never the root, which would flip the label).
 *
 * Both local and remote players share this rig; only the clothing color differs
 * (LOCAL_COLOR vs REMOTE_COLOR), passed in as `color`.
 */

const FULL_W = PLAYER_HALF_W * 2; // 32
const FULL_H = PLAYER_HALF_H * 2; // 48

// Maple proportion: a big head ~40% of total height. Everything else is laid
// out below the head, measured from the AABB top edge (y = -PLAYER_HALF_H).
const HEAD_H = FULL_H * 0.4; // 19.2
const HEAD_R = HEAD_H / 2;
const TOP = -PLAYER_HALF_H;
const HEAD_CY = TOP + HEAD_R; // head center

const TORSO_W = FULL_W * 0.62;
const TORSO_H = FULL_H * 0.3;
const TORSO_TOP = HEAD_CY + HEAD_R - 1; // tuck under the head slightly

const LEG_W = 5;
const LEG_H = FULL_H - (TORSO_TOP + TORSO_H - TOP); // fill down to the AABB bottom
const LEG_TOP = TORSO_TOP + TORSO_H;
const LEG_SPREAD = TORSO_W * 0.26; // horizontal offset of each leg from center

const ARM_W = 4;
const ARM_H = TORSO_H * 1.05;
const ARM_TOP = TORSO_TOP + 1;
const ARM_SPREAD = TORSO_W / 2 + ARM_W / 2 - 1; // arms hang off the torso sides

const SKIN = 0xf2d6b3;
const EYE = 0x10131b;
const EYE_R = 1.6;

// --- Animation tuning (named so the cadence is legible and not magic) ---
const IDLE_PERIOD_MS = 2200; // gentle breathing
const IDLE_BOB_PX = 1.2;
const WALK_PHASE_RATE = 0.014; // rad per (px/s * ms): |vx| drives leg cadence
const WALK_SWING_RAD = 0.5; // peak leg/arm swing while walking
const CLIMB_PHASE_RATE = 0.02; // rad per (px/s * ms) from |vy| while climbing
const CLIMB_REACH_PX = 5; // how far hands alternate up/down on the rope
const ATTACK_SWING_RAD = 1.4; // forward arm rotation at the peak of a swing
const ATTACK_DURATION_MS = 120; // matches the GameApp swing-anim window

/** Per-frame pose the rig animates from; all sourced from sim/interp state. */
export interface Pose {
  vx: number;
  vy: number;
  onGround: boolean;
  /** True while holding/climbing a rope (rope index >= 0). */
  climbing: boolean;
  /** Milliseconds left in the current attack swing animation (>0 while playing). */
  attackSwingMs: number;
}

export interface CharacterRig {
  /** The mirror-able body container (parented under the player root). */
  body: Container;
  /** Advance the animation by dtMs toward `pose`. */
  update(dtMs: number, pose: Pose): void;
}

export function createCharacterRig(color: number): CharacterRig {
  const body = new Container();

  // Legs first (drawn behind the torso). Each leg pivots about its TOP so a
  // rotation swings the foot, like a hinge at the hip.
  const legBack = makeLimb(LEG_W, LEG_H, color);
  const legFront = makeLimb(LEG_W, LEG_H, color);
  legBack.position.set(-LEG_SPREAD, LEG_TOP);
  legFront.position.set(LEG_SPREAD, LEG_TOP);

  // Back arm behind torso, front arm in front, so an attack swing reads clearly.
  const armBack = makeLimb(ARM_W, ARM_H, SKIN);
  const armFront = makeLimb(ARM_W, ARM_H, SKIN);
  armBack.position.set(-ARM_SPREAD, ARM_TOP);
  armFront.position.set(ARM_SPREAD, ARM_TOP);

  const torso = new Graphics()
    .roundRect(-TORSO_W / 2, TORSO_TOP, TORSO_W, TORSO_H, 4)
    .fill(color);

  const head = new Graphics().circle(0, HEAD_CY, HEAD_R).fill(SKIN);
  // Two eyes, biased toward the +x (facing) side so a flip reads as turning.
  const eyes = new Graphics()
    .circle(HEAD_R * 0.25, HEAD_CY + 1, EYE_R)
    .circle(HEAD_R * 0.7, HEAD_CY + 1, EYE_R)
    .fill(EYE);

  // Draw order: back limbs, torso, front limbs, head, eyes.
  body.addChild(legBack, armBack, torso, legFront, armFront, head, eyes);

  const idle = createOscillator(IDLE_PERIOD_MS);
  const walkPhase = createPhase();
  const climbPhase = createPhase();

  function update(dtMs: number, pose: Pose): void {
    const speed = Math.abs(pose.vx);

    if (pose.climbing) {
      // Climbing: arms up and alternating, legs tucked together. Hands reach
      // up/down on a phase from |vy| so faster climbing = quicker hand-over-hand.
      climbPhase.advance(Math.abs(pose.vy) * CLIMB_PHASE_RATE * dtMs);
      const c = Math.sin(climbPhase.value);
      armFront.rotation = -2.4; // raised overhead
      armBack.rotation = 2.4;
      armFront.y = ARM_TOP - CLIMB_REACH_PX * c;
      armBack.y = ARM_TOP + CLIMB_REACH_PX * c;
      legFront.rotation = 0.12;
      legBack.rotation = -0.12;
      body.y = 0;
      idle.tick(dtMs); // keep idle phase live for a smooth exit
    } else if (!pose.onGround) {
      // Airborne: legs tuck up when rising, trail down when falling (vy sign).
      const rising = pose.vy < 0;
      const tuck = rising ? 0.7 : -0.35;
      legFront.rotation = tuck;
      legBack.rotation = tuck * 0.6;
      armFront.y = ARM_TOP;
      armBack.y = ARM_TOP;
      armFront.rotation = rising ? -0.6 : 0.3;
      armBack.rotation = rising ? 0.6 : -0.3;
      body.y = 0;
      idle.tick(dtMs);
    } else if (speed > 1) {
      // Walking: legs (and arms, counter-phase) swing; cadence tracks |vx|.
      walkPhase.advance(speed * WALK_PHASE_RATE * dtMs);
      const s = Math.sin(walkPhase.value);
      legFront.rotation = WALK_SWING_RAD * s;
      legBack.rotation = -WALK_SWING_RAD * s;
      armFront.rotation = -WALK_SWING_RAD * 0.7 * s;
      armBack.rotation = WALK_SWING_RAD * 0.7 * s;
      armFront.y = ARM_TOP;
      armBack.y = ARM_TOP;
      body.y = 0;
      idle.tick(dtMs);
    } else {
      // Idle: a gentle breathing bob of the whole body; limbs at rest.
      const b = idle.tick(dtMs);
      legFront.rotation = 0;
      legBack.rotation = 0;
      armFront.rotation = 0;
      armBack.rotation = 0;
      armFront.y = ARM_TOP;
      armBack.y = ARM_TOP;
      body.y = IDLE_BOB_PX * b;
    }

    // Attack overlays whatever the front arm is doing: a quick forward swing,
    // strongest at the start of the window and easing back to rest. Driven by
    // the remaining swing time so it stays synced with the slash effect. The
    // limb hangs along +y, so a NEGATIVE rotation throws the hand toward +x —
    // the facing direction (the whole body mirrors for a left-facing swing).
    if (pose.attackSwingMs > 0) {
      const k = Math.min(1, pose.attackSwingMs / ATTACK_DURATION_MS);
      armFront.rotation = -ATTACK_SWING_RAD * k;
    }
  }

  return { body, update };
}

/**
 * A limb as a top-pivoting rounded bar: drawn from y=0 downward so setting
 * `rotation` swings it about the hip/shoulder rather than its middle. Returned
 * positioned at (0,0); the caller sets its attachment point.
 */
function makeLimb(w: number, h: number, color: number): Graphics {
  return new Graphics().roundRect(-w / 2, 0, w, h, w / 2).fill(color);
}
