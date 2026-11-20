/**
 * Walk-cycle math for the pose-frame avatar (Phase 5 増分①a).
 *
 * Walking is DERIVED, never synced: the phase advances with the horizontal
 * distance the rendered sprite actually moved this frame, so the same rule
 * animates the local player (predicted pose) and remote players
 * (interpolated pose) without any new networked data — the stride stays in
 * step with on-screen motion by construction, whatever produced it.
 *
 * Pure functions only; the PixiJS side (avatarView.ts) just shows the
 * selected pose frame.
 */

export interface WalkState {
  phase: number;
  intensity: number;
}

export const WALK_POSES = ['walk-a', 'walk-b', 'walk-c', 'walk-d'] as const;

export type AvatarPose = 'stand' | (typeof WALK_POSES)[number];

export const IDLE_WALK_STATE: WalkState = { phase: 0, intensity: 0 };

/**
 * One full stride (all WALK_POSES once) per this many logical pixels of
 * horizontal travel. At MOVE_SPEED (240 px/s) this paces the cycle at
 * 240/192 = 1.25 strides/s = 2.5 steps/s — a natural walk cadence, each
 * frame showing for 200ms. The spike's 64 played 3.75 cycles/s (7.5
 * steps/s), which read as frantic shuffling once the frames became real
 * poses (2026-08-08 review).
 */
const STRIDE_PX = 192;
const PHASE_PER_PX = (2 * Math.PI) / STRIDE_PX;
/**
 * Rendered speed (logical px/s) above which a frame's motion is treated as
 * a discontinuity (portal teleport, correction snap), not travel: such a
 * frame neither advances the phase nor counts as walking. Real movement
 * never exceeds MOVE_SPEED (240 px/s) even on a long catch-up frame that
 * simulates many ticks at once, so double that separates lag from jumps.
 */
const MAX_TRAVEL_SPEED = 480;
const WALK_SPEED_MIN = 30;
const INTENSITY_TAU_MS = 90;
/**
 * The intensity above which the walk frames replace the stand frame. The
 * ease across this threshold (~60ms each way at INTENSITY_TAU_MS) is what
 * debounces the swap: a single noisy frame of drift or a one-frame stall
 * cannot flicker the pose.
 */
const WALK_POSE_MIN_INTENSITY = 0.5;

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

export function selectPose(state: WalkState): AvatarPose {
  if (state.intensity < WALK_POSE_MIN_INTENSITY) return 'stand';
  const slice = Math.floor((state.phase / (2 * Math.PI)) * WALK_POSES.length);
  return WALK_POSES[slice % WALK_POSES.length];
}
