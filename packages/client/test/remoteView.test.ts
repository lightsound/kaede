import { type Facing, GRAVITY, INTERP_DELAY_MS, MAX_FALL_SPEED } from '@kaede/shared';
import { describe, expect, it } from 'vitest';
import {
  createRemoteViews,
  REMOTE_EXTRAPOLATION_MAX_MS,
  sampleAt,
} from '../src/net.package/remoteView';

const facing: Facing = 1;

/** A snapshot on the server timeline with sensible defaults (grounded, at rest). */
function snap(
  t: number,
  x: number,
  over: Partial<{ y: number; vx: number; vy: number; airborne: boolean }> = {},
) {
  return {
    t,
    x,
    y: over.y ?? 0,
    vx: over.vx ?? 0,
    vy: over.vy ?? 0,
    facing,
    airborne: over.airborne ?? false,
  };
}

describe('sampleAt', () => {
  it('clamps before the oldest snapshot', () => {
    const buf = [snap(1000, 10), snap(1100, 20)];
    expect(sampleAt(buf, 900).x).toBe(10);
  });

  it('interpolates between straddling snapshots (exact at endpoints)', () => {
    const buf = [snap(1000, 10, { vx: 100 }), snap(1100, 20, { vx: 100 })];
    expect(sampleAt(buf, 1000).x).toBe(10);
    expect(sampleAt(buf, 1100).x).toBeCloseTo(20, 10);
    const mid = sampleAt(buf, 1050);
    expect(mid.x).toBeGreaterThan(10);
    expect(mid.x).toBeLessThan(20);
  });

  it('extrapolates past the newest snapshot along its velocity', () => {
    const buf = [snap(1000, 10), snap(1100, 20, { vx: 100 })];
    // 50ms past the last snapshot at 100px/s: 5px further.
    expect(sampleAt(buf, 1150).x).toBeCloseTo(25, 10);
  });

  it('caps extrapolation at REMOTE_EXTRAPOLATION_MAX_MS, then freezes', () => {
    const buf = [snap(1100, 20, { vx: 100 })];
    const capped = 20 + (100 * REMOTE_EXTRAPOLATION_MAX_MS) / 1000;
    expect(sampleAt(buf, 1100 + REMOTE_EXTRAPOLATION_MAX_MS).x).toBeCloseTo(capped, 10);
    expect(sampleAt(buf, 1100 + REMOTE_EXTRAPOLATION_MAX_MS + 5000).x).toBeCloseTo(capped, 10);
  });

  it('does not move a standing player when snapshots run dry', () => {
    const buf = [snap(1100, 20)];
    expect(sampleAt(buf, 9999).x).toBe(20);
  });

  it('extrapolates an airborne sample under gravity, not in a straight line', () => {
    // Rising at -840px/s: 200ms of gravity bends the path well below the
    // straight-line continuation (the "floating remote player" bug).
    const buf = [snap(1100, 20, { y: 0, vy: -840, airborne: true })];
    const s = sampleAt(buf, 1300);
    expect(s.y).toBeCloseTo(-840 * 0.2 + (GRAVITY * 0.2 * 0.2) / 2, 10);
    expect(s.y).toBeGreaterThan(-840 * 0.2); // higher y = lower on screen
  });

  it('extrapolates an airborne fall at terminal velocity without further acceleration', () => {
    // stepPlayer clamps vy at MAX_FALL_SPEED, so a terminal-velocity sample
    // must keep falling linearly — no gravity on top of the clamp.
    const buf = [snap(1100, 20, { y: 0, vy: MAX_FALL_SPEED, airborne: true })];
    expect(sampleAt(buf, 1300).y).toBeCloseTo(MAX_FALL_SPEED * 0.2, 10);
  });

  it('does not pull a grounded sample down when extrapolating', () => {
    // Grounded rows carry vy = 0; gravity would sink them through the floor.
    const buf = [snap(1100, 20, { y: 50, vx: 100 })];
    const s = sampleAt(buf, 1300);
    expect(s.y).toBe(50);
    expect(s.x).toBeCloseTo(40, 10);
  });
});

describe('createRemoteViews', () => {
  /** Row shape record() expects, built from a server-time position sample. */
  function row(updatedAtMs: number, x: number, vx = 0) {
    return { x, y: 0, vx, vy: 0, facing: 1, onGround: true, rope: -1, updatedAtMs };
  }

  /** The display attributes record() expects; everything but the name defaults to "none". */
  function label(name: string, status?: string, zone?: string) {
    return { name, status, zone, gesture: undefined, availability: undefined };
  }

  /** Collect draw() calls for one renderFrame. */
  function render(views: ReturnType<typeof createRemoteViews>, nowMs: number) {
    const drawn: {
      id: string;
      status: string | undefined;
      zone: string | undefined;
      gesture: string | undefined;
      availability: string | undefined;
      x: number;
      y: number;
    }[] = [];
    views.renderFrame(nowMs, (id, l, x, y) =>
      drawn.push({
        id,
        status: l.status,
        zone: l.zone,
        gesture: l.gesture,
        availability: l.availability,
        x,
        y,
      }),
    );
    return drawn;
  }

  it('renders INTERP_DELAY_MS in the past on the server timeline', () => {
    const views = createRemoteViews();
    // Constant 40ms delivery delay; player moves 10px per 100ms server tick.
    // Enough samples that renderTime (INTERP_DELAY_MS in the past) still
    // falls between buffered snapshots.
    for (let i = 0; i <= 12; i++) {
      views.record('a', label('A'), row(i * 100, i * 10, 100), i * 100 + 40);
    }
    // Local 1240 maps to server 1200; render time is 1200 - INTERP_DELAY_MS.
    const drawn = render(views, 1240);
    expect(drawn).toHaveLength(1);
    expect(drawn[0].x).toBeCloseTo((1200 - INTERP_DELAY_MS) / 10, 5);
  });

  it('derives airborne from the row (onGround/rope), so run-dry extrapolation falls', () => {
    const views = createRemoteViews();
    views.record('a', label('A'), { ...row(0, 0), onGround: false, vy: -840 }, 40);
    // Local 640 maps to server 600; renderTime sits 50ms past the only snapshot.
    const drawn = render(views, 640);
    expect(drawn[0].y).toBeCloseTo(-840 * 0.05 + (GRAVITY * 0.05 * 0.05) / 2, 8);
  });

  it('is immune to delivery jitter of individual updates', () => {
    const jittered = createRemoteViews();
    const steady = createRemoteViews();
    for (let i = 0; i <= 5; i++) {
      // Same server-time samples; one connection delivers with jitter.
      const jitter = i % 2 === 0 ? 0 : 35;
      jittered.record('a', label('A'), row(i * 100, i * 10, 100), i * 100 + 40 + jitter);
      steady.record('a', label('A'), row(i * 100, i * 10, 100), i * 100 + 40);
    }
    // Both estimated the same (minimum) offset, so they render identically.
    expect(render(jittered, 540)[0].x).toBeCloseTo(render(steady, 540)[0].x, 5);
  });

  it('carries the recorded status into draw() and follows setStatus updates', () => {
    const views = createRemoteViews();
    views.record('a', label('A', '🟢 もくもく'), row(0, 0), 40);
    expect(render(views, 240)[0].status).toBe('🟢 もくもく');
    views.setStatus('a', '🔴 取り込み中', 'busy');
    expect(render(views, 250)[0].status).toBe('🔴 取り込み中');
    views.setStatus('a', undefined, undefined);
    expect(render(views, 260)[0].status).toBeUndefined();
    // A view that does not exist is skipped, not created (the setName rule).
    views.setStatus('ghost', '🟡 離席', 'away');
    expect(render(views, 270).map((d) => d.id)).toEqual(['a']);
  });

  it('carries the recorded gesture into draw() and follows setGesture updates', () => {
    const views = createRemoteViews();
    views.record('a', { ...label('A'), gesture: 'sit' }, row(0, 0), 40);
    expect(render(views, 240)[0].gesture).toBe('sit');
    views.setGesture('a', 'dance');
    expect(render(views, 250)[0].gesture).toBe('dance');
    // The server clears the row on movement; the delete must clear the pose.
    views.setGesture('a', undefined);
    expect(render(views, 260)[0].gesture).toBeUndefined();
    // A view that does not exist is skipped, not created (the setName rule).
    views.setGesture('ghost', 'sleep');
    expect(render(views, 270).map((d) => d.id)).toEqual(['a']);
  });

  it('carries availability through setStatus for the derived poses', () => {
    const views = createRemoteViews();
    views.record('a', label('A'), row(0, 0), 40);
    views.setStatus('a', '🟡 離席', 'away');
    expect(render(views, 250)[0].availability).toBe('away');
  });

  it('carries the recorded zone tag into draw() and follows setZone updates', () => {
    const views = createRemoteViews();
    views.record('a', label('A', undefined, '📍 会議室A'), row(0, 0), 40);
    expect(render(views, 240)[0].zone).toBe('📍 会議室A');
    views.setZone('a', '📍 会議室B');
    expect(render(views, 250)[0].zone).toBe('📍 会議室B');
    views.setZone('a', undefined);
    expect(render(views, 260)[0].zone).toBeUndefined();
    // A view that does not exist is skipped, not created (the setName rule).
    views.setZone('ghost', '📍 会議室A');
    expect(render(views, 270).map((d) => d.id)).toEqual(['a']);
  });

  it('remove() and clear() drop views', () => {
    const views = createRemoteViews();
    views.record('a', label('A'), row(0, 0), 40);
    views.record('b', label('B'), row(0, 0), 40);
    views.remove('a');
    expect(render(views, 240).map((d) => d.id)).toEqual(['b']);
    views.clear();
    expect(render(views, 250)).toHaveLength(0);
  });
});
