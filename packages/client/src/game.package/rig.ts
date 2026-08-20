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

/** The walk animation state carried per player view across frames. */
export interface WalkState {
  /** Walk-cycle phase in radians; advances with rendered horizontal motion. */
  phase: number;
  /** 0 = standing, 1 = fully walking; eases between the two on start/stop. */
  intensity: number;
}

/**
 * The canonical walk-cycle pose names in stride order (avatar/manifest.json
 * poses). Twenty-four frames per stride since the video-native
 * densification (owner rulings 2026-08-20: A-3, then「24 で進めて」— the
 * masters carry a 24-frame cycle and the dense sheets ship EVERY frame of
 * it as-is, no head composite): the contacts land on walk-a and walk-m,
 * the passings on walk-g and walk-s. Legacy sheets that were left at 4
 * frames (the carry-light family — 裁定④ 据え置き 2026-08-19) use the
 * first four names; selectPose takes the sheet's own pose list, so both
 * densities animate correctly side by side.
 */
export const WALK_POSES = [
  'walk-a',
  'walk-b',
  'walk-c',
  'walk-d',
  'walk-e',
  'walk-f',
  'walk-g',
  'walk-h',
  'walk-i',
  'walk-j',
  'walk-k',
  'walk-l',
  'walk-m',
  'walk-n',
  'walk-o',
  'walk-p',
  'walk-q',
  'walk-r',
  'walk-s',
  'walk-t',
  'walk-u',
  'walk-v',
  'walk-w',
  'walk-x',
] as const;

/** One pose frame of the avatar sheet (docs/avatar-rig.md §3). */
export type AvatarPose = 'stand' | (typeof WALK_POSES)[number];

export const IDLE_WALK_STATE: WalkState = { phase: 0, intensity: 0 };

/**
 * One full stride (one pass through a sheet's walk frames) per this many
 * logical pixels of horizontal travel. At MOVE_SPEED (240 px/s) this paces
 * the cycle at 240/192 = 1.25 strides/s = 2.5 steps/s — a natural walk
 * cadence (~67ms per frame on the dense 12-frame sheets, 200ms on the
 * legacy 4-frame ones). The spike's 64 played 3.75 cycles/s (7.5 steps/s),
 * which read as frantic shuffling once the frames became real poses
 * (2026-08-08 review).
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
/** Rendered speed (logical px/s) below which the player counts as standing. */
const WALK_SPEED_MIN = 30;
/** Time constant for easing intensity toward walking/standing. */
const INTENSITY_TAU_MS = 90;
/**
 * The intensity above which the walk frames replace the stand frame. The
 * ease across this threshold (~60ms each way at INTENSITY_TAU_MS) is what
 * debounces the swap: a single noisy frame of drift or a one-frame stall
 * cannot flicker the pose.
 */
const WALK_POSE_MIN_INTENSITY = 0.5;

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
 * The pose frame for a walk state: standing below the intensity threshold,
 * otherwise the walk cycle frame the phase has reached — each frame owns an
 * equal slice of the stride, so the cadence follows rendered travel
 * (STRIDE_PX / walkPoses.length pixels per frame). `walkPoses` is the
 * SHEET's own walk list in stride order (12 on the dense sheets, 4 on the
 * legacy carry-light sheets); the default is the canonical dense list.
 */
export function selectPose(state: WalkState, walkPoses: readonly string[] = WALK_POSES): string {
  if (state.intensity < WALK_POSE_MIN_INTENSITY || walkPoses.length === 0) return 'stand';
  const slice = Math.floor((state.phase / (2 * Math.PI)) * walkPoses.length);
  return walkPoses[slice % walkPoses.length] ?? 'stand';
}
