/**
 * Walk-cycle math for the parts-split avatar rig (Phase 5 spike).
 *
 * Walking is DERIVED, never synced: the phase advances with the horizontal
 * distance the rendered sprite actually moved this frame, so the same rule
 * animates the local player (predicted pose) and remote players
 * (interpolated pose) without any new networked data — the stride stays in
 * step with on-screen motion by construction, whatever produced it.
 *
 * Pure functions only; the PixiJS side (partsAvatar.ts) just applies the
 * returned pose to its display objects.
 */

/** The walk animation state carried per player view across frames. */
export interface WalkState {
  /** Walk-cycle phase in radians; advances with rendered horizontal motion. */
  phase: number;
  /** 0 = standing pose, 1 = full swing; eases between the two on start/stop. */
  intensity: number;
}

/** Per-part pose for one frame: joint rotations in radians plus the body bob. */
export interface RigPose {
  legNear: number;
  legFar: number;
  armNear: number;
  armFar: number;
  head: number;
  /** Vertical offset of the whole figure in logical px (negative = up). */
  bob: number;
}

export const IDLE_WALK_STATE: WalkState = { phase: 0, intensity: 0 };

/** One full stride per this many logical pixels of horizontal travel. */
const STRIDE_PX = 64;
const PHASE_PER_PX = (2 * Math.PI) / STRIDE_PX;
/**
 * Rendered speed (logical px/s) above which a frame's motion is treated as
 * a discontinuity (portal teleport, correction snap), not travel: such a
 * frame neither advances the phase nor counts as walking. Real movement
 * never exceeds MOVE_SPEED (240 px/s) even on a long catch-up frame that
 * simulates many ticks at once, so double that separates lag from jumps.
 */
const MAX_TRAVEL_SPEED = 480;
/** Rendered speed (logical px/s) below which the player counts as standing. */
const WALK_SPEED_MIN = 30;
/** Time constant for easing intensity toward walking/standing. */
const INTENSITY_TAU_MS = 90;

/** Joint swing amplitudes at full intensity (radians) and the bob depth (px). */
const LEG_SWING = 0.55;
const ARM_SWING = 0.45;
const HEAD_TILT = 0.04;
const BOB_PX = 1.5;

/**
 * Advances the walk state by one rendered frame: `dxPx` is how far the
 * sprite moved horizontally (logical px, sign ignored), `dtMs` the frame
 * time. Returns a new state; never mutates.
 */
export function advanceWalk(state: WalkState, dxPx: number, dtMs: number): WalkState {
  if (dtMs <= 0) return state;
  const speed = (Math.abs(dxPx) / dtMs) * 1000;
  const step = speed <= MAX_TRAVEL_SPEED ? Math.abs(dxPx) : 0;
  const walking = step > 0 && speed >= WALK_SPEED_MIN;
  const blend = 1 - Math.exp(-dtMs / INTENSITY_TAU_MS);
  return {
    phase: (state.phase + step * PHASE_PER_PX) % (2 * Math.PI),
    intensity: state.intensity + ((walking ? 1 : 0) - state.intensity) * blend,
  };
}

/**
 * The pose for a walk state: legs swing in antiphase, arms counter the
 * legs, the head tilts subtly with the stride, and the figure bobs down
 * at each leg crossing. At intensity 0 every joint is neutral.
 */
export function walkPose(state: WalkState): RigPose {
  const swing = Math.sin(state.phase) * state.intensity;
  return {
    legNear: swing * LEG_SWING,
    legFar: -swing * LEG_SWING,
    armNear: -swing * ARM_SWING,
    armFar: swing * ARM_SWING,
    head: swing * HEAD_TILT,
    bob: -Math.abs(swing) * BOB_PX,
  };
}
