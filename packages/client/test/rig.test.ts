import { describe, expect, it } from 'vitest';
import { advanceWalk, IDLE_WALK_STATE, walkPose } from '../src/game.package/rig';

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

  it('clamps a teleport-sized jump instead of spinning the legs', () => {
    const jump = advanceWalk(IDLE_WALK_STATE, 1500, FRAME_MS);
    expect(jump.phase).toBeLessThan(Math.PI * 2 * 0.25); // well under one stride
  });

  it('returns the state unchanged for a zero-length frame', () => {
    expect(advanceWalk(IDLE_WALK_STATE, WALK_DX, 0)).toBe(IDLE_WALK_STATE);
  });
});

describe('walkPose', () => {
  it('is fully neutral at idle', () => {
    for (const joint of Object.values(walkPose(IDLE_WALK_STATE))) {
      expect(joint).toBeCloseTo(0);
    }
  });

  it('swings the legs in antiphase and the arms counter to the legs', () => {
    const pose = walkPose({ phase: Math.PI / 2, intensity: 1 });
    expect(pose.legNear).toBeGreaterThan(0);
    expect(pose.legFar).toBeCloseTo(-pose.legNear);
    expect(Math.sign(pose.armNear)).toBe(-Math.sign(pose.legNear));
    expect(pose.armFar).toBeCloseTo(-pose.armNear);
  });

  it('bobs the figure down (never up) with the stride', () => {
    expect(walkPose({ phase: Math.PI / 2, intensity: 1 }).bob).toBeLessThan(0);
    expect(walkPose({ phase: Math.PI * 1.5, intensity: 1 }).bob).toBeLessThan(0);
  });

  it('scales every joint with intensity', () => {
    const full = walkPose({ phase: Math.PI / 2, intensity: 1 });
    const half = walkPose({ phase: Math.PI / 2, intensity: 0.5 });
    expect(half.legNear).toBeCloseTo(full.legNear / 2);
    expect(half.armFar).toBeCloseTo(full.armFar / 2);
    expect(half.bob).toBeCloseTo(full.bob / 2);
  });
});
