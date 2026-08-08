import { describe, expect, it } from 'vitest';
import { advanceWalk, IDLE_WALK_STATE, selectPose, WALK_POSES } from '../src/game.package/rig';

// One 60fps frame moving at a typical walk speed (~180 logical px/s).
const FRAME_MS = 16.7;
const WALK_DX = 3;

/** Runs `frames` frames of steady motion (dx per frame) from `state`. */
function run(state = IDLE_WALK_STATE, frames = 1, dx = WALK_DX) {
  let s = state;
  for (let i = 0; i < frames; i++) s = advanceWalk(s, dx, FRAME_MS);
  return s;
}

describe('advanceWalk', () => {
  it('advances the phase with horizontal motion', () => {
    expect(run().phase).toBeGreaterThan(0);
  });

  it('holds the phase while standing still', () => {
    expect(run(IDLE_WALK_STATE, 5, 0).phase).toBe(0);
  });

  it('ignores the sign of the motion (walking left strides too)', () => {
    expect(run(IDLE_WALK_STATE, 3, -WALK_DX).phase).toEqual(run(IDLE_WALK_STATE, 3, WALK_DX).phase);
  });

  it('eases intensity toward 1 while moving', () => {
    const early = run(IDLE_WALK_STATE, 2);
    const late = run(IDLE_WALK_STATE, 30);
    expect(early.intensity).toBeGreaterThan(0);
    expect(early.intensity).toBeLessThan(late.intensity);
    expect(late.intensity).toBeGreaterThan(0.95);
  });

  it('eases intensity back toward 0 after stopping', () => {
    const walking = run(IDLE_WALK_STATE, 30);
    const stopped = run(walking, 30, 0);
    expect(stopped.intensity).toBeLessThan(0.05);
  });

  it('treats sub-threshold drift as standing', () => {
    const s = run(IDLE_WALK_STATE, 30, 0.1);
    expect(s.intensity).toBeLessThan(0.05);
  });

  it('treats a teleport-sized jump as a discontinuity: no stride, no walking', () => {
    const walking = run(IDLE_WALK_STATE, 30);
    const jump = advanceWalk(walking, 1500, FRAME_MS);
    expect(jump.phase).toBe(walking.phase); // the legs did not spin
    expect(jump.intensity).toBeLessThanOrEqual(walking.intensity);
  });

  it('keeps a lag frame walking: many ticks of travel in one long frame', () => {
    // 120px over 500ms is ordinary MOVE_SPEED travel, just delivered late.
    const walking = run(IDLE_WALK_STATE, 30);
    const lag = advanceWalk(walking, 120, 500);
    expect(lag.intensity).toBeGreaterThan(0.9);
    expect(lag.phase).not.toBe(walking.phase); // the stride advanced with the travel
  });

  it('returns the state unchanged for a zero-length frame', () => {
    expect(advanceWalk(IDLE_WALK_STATE, WALK_DX, 0)).toBe(IDLE_WALK_STATE);
  });
});

describe('selectPose', () => {
  it('stands at idle', () => {
    expect(selectPose(IDLE_WALK_STATE)).toBe('stand');
  });

  it('keeps standing through the first instants of motion (debounce)', () => {
    expect(selectPose(run(IDLE_WALK_STATE, 1))).toBe('stand');
  });

  it('shows a walk frame once steadily walking', () => {
    expect(WALK_POSES).toContain(selectPose(run(IDLE_WALK_STATE, 30)));
  });

  it('returns to standing after stopping', () => {
    const walking = run(IDLE_WALK_STATE, 30);
    expect(selectPose(run(walking, 30, 0))).toBe('stand');
  });

  it('gives each walk frame an equal quarter of the stride, in cycle order', () => {
    const quarter = Math.PI / 2;
    for (const [index, pose] of WALK_POSES.entries()) {
      expect(selectPose({ phase: index * quarter, intensity: 1 })).toBe(pose);
      expect(selectPose({ phase: (index + 1) * quarter - 1e-9, intensity: 1 })).toBe(pose);
    }
  });

  it('advances through the cycle with continued travel', () => {
    let state = run(IDLE_WALK_STATE, 30); // steady walk, some phase
    const seen = new Set([selectPose(state)]);
    for (let i = 0; i < 90; i++) {
      state = advanceWalk(state, WALK_DX, FRAME_MS);
      seen.add(selectPose(state));
    }
    // 90 more frames ≈ 270px ≈ 1.4 strides: every cycle frame appears.
    for (const pose of WALK_POSES) expect(seen).toContain(pose);
  });
});
