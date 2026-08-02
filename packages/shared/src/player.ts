import {
  CLIMB_SPEED,
  DT,
  GRAVITY,
  JUMP_VELOCITY,
  MAX_FALL_SPEED,
  MOVE_SPEED,
  PLATFORM_DROP_NUDGE,
  PLAYER_HALF_H,
  PLAYER_HALF_W,
  ROPE_GRAB_RANGE,
  ROPE_JUMP_VELOCITY,
} from './constants';
import { unpackInput } from './input';
import { type AABB, overlaps, rectBounds } from './physics';
import type { CollisionMap, Facing, PlayerInput, PlayerState, Rect, Rope } from './types';

function box(x: number, y: number): AABB {
  return { cx: x, cy: y, hw: PLAYER_HALF_W, hh: PLAYER_HALF_H };
}

/** True when the player's horizontal span at center x overlaps the rect's. */
function spansRect(x: number, r: Rect): boolean {
  return x + PLAYER_HALF_W > r.x && x - PLAYER_HALF_W < r.x + r.w;
}

/** Normalize a raw facing column (any sign) into the Facing union. */
export function toFacing(f: number): Facing {
  return f < 0 ? -1 : 1;
}

/**
 * True when the state is a fixpoint of empty input: standing on ground, not
 * moving, not on a rope — stepPlayer(state, 無入力) returns the same state
 * (gravity pulls, but the ground collision resolves it right back; unit
 * tested as the invariant both sides rely on). This is what lets the
 * protocol elide ticks: the client's send gate (evaluateSendWindow) goes
 * silent only from a quiescent state, and the server accepts the resulting
 * startTick gap only when its row is quiescent, because the elided empty
 * ticks provably changed nothing.
 *
 * ロープ上で静止しているぶら下がりも実際には不動点だが、静止扱いに
 * しない(仕様: 接地・速度ゼロ・ロープ非使用)— 不動点性がマップの
 * ロープ定義に依存するため、地面より保証が弱い。ロープ上の放置は
 * 空入力を送り続けるだけで、正しさは変わらない。
 */
export function isQuiescent(state: PlayerState): boolean {
  return state.onGround && state.vx === 0 && state.vy === 0 && state.rope === -1;
}

/** Build a PlayerState from a player row's dynamic columns. */
export function stateFromRow(r: {
  x: number;
  y: number;
  vx: number;
  vy: number;
  facing: number;
  onGround: boolean;
  rope: number;
}): PlayerState {
  return {
    x: r.x,
    y: r.y,
    vx: r.vx,
    vy: r.vy,
    facing: toFacing(r.facing),
    onGround: r.onGround,
    rope: r.rope,
  };
}

/**
 * The one-way platform the player's feet are resting on, if any. Landing snaps
 * y to exactly top - PLAYER_HALF_H, so the equality test is exact.
 */
function platformUnderfoot(state: PlayerState, map: CollisionMap): Rect | undefined {
  if (!state.onGround) return undefined;
  return map.platforms.find((p) => state.y + PLAYER_HALF_H === p.y && spansRect(state.x, p));
}

/**
 * The rope the player can grab this tick, or -1. Up grabs a rope whose span
 * continues above the center (climbing on); down grabs a rope hanging below
 * the feet while standing at its top (climbing off a platform edge). Holding
 * jump disables the down-grab so that down+jump means "drop through the
 * platform", not "climb down the rope".
 */
function grabRope(state: PlayerState, input: PlayerInput, map: CollisionMap): number {
  for (let i = 0; i < map.ropes.length; i++) {
    const r = map.ropes[i];
    if (Math.abs(state.x - r.x) > ROPE_GRAB_RANGE) continue;
    const upGrab = input.up && state.y > r.top && state.y <= r.bottom;
    const downGrab =
      input.down &&
      !input.jump &&
      state.onGround &&
      state.y < r.top &&
      state.y + PLAYER_HALF_H >= r.top;
    if (upGrab || downGrab) return i;
  }
  return -1;
}

/**
 * One tick of climbing on `rope`: up/down drive y directly, and gravity and
 * collision are suspended. Passing either end lets go — off the top the player
 * steps onto whatever the rope hangs from, off the bottom they fall.
 */
function climb(state: PlayerState, input: PlayerInput, rope: Rope): PlayerState {
  const dir = (input.down ? 1 : 0) - (input.up ? 1 : 0);
  const y = state.y + dir * CLIMB_SPEED * DT;
  const at = (cy: number, onGround: boolean, held: number): PlayerState => ({
    x: rope.x,
    y: cy,
    vx: 0,
    vy: 0,
    facing: state.facing,
    onGround,
    rope: held,
  });
  if (y < rope.top) return at(rope.top - PLAYER_HALF_H, true, -1);
  if (y > rope.bottom) return at(rope.bottom, false, -1);
  return at(y, false, state.rope);
}

/**
 * Outcome of the rope phase. `done` means the tick was fully handled on a rope;
 * otherwise `state` is what the regular ground step continues from.
 */
interface ClimbStep {
  done: boolean;
  state: PlayerState;
}

/**
 * Resolves the player's relationship with ropes for this tick: keep climbing,
 * jump off, grab on, or nothing. A directional jump releases the rope and does
 * NOT finish the tick (a plain jump keeps climbing), so the horizontal input
 * still takes effect through the regular step below.
 */
function stepRopePhase(state: PlayerState, input: PlayerInput, map: CollisionMap): ClimbStep {
  const rope = state.rope >= 0 ? map.ropes[state.rope] : undefined;
  if (rope) {
    if (input.jump && (input.left || input.right)) {
      const released = { ...state, rope: -1, vy: ROPE_JUMP_VELOCITY, onGround: false };
      return { done: false, state: released };
    }
    return { done: true, state: climb(state, input, rope) };
  }

  if (input.up || input.down) {
    const grabbed = grabRope(state, input, map);
    if (grabbed >= 0) {
      const r = map.ropes[grabbed];
      const y = Math.min(Math.max(state.y, r.top), r.bottom);
      const held = {
        x: r.x,
        y,
        vx: 0,
        vy: 0,
        facing: state.facing,
        onGround: false,
        rope: grabbed,
      };
      return { done: true, state: held };
    }
  }
  return { done: false, state };
}

/** This tick's horizontal velocity, plus the facing it implies. */
function horizontalIntent(state: PlayerState, input: PlayerInput): { vx: number; facing: Facing } {
  const vx = ((input.right ? 1 : 0) - (input.left ? 1 : 0)) * MOVE_SPEED;
  if (vx > 0) return { vx, facing: 1 };
  if (vx < 0) return { vx, facing: -1 };
  return { vx, facing: state.facing };
}

/**
 * Applies jump / drop-through to the tick's starting y and vertical velocity,
 * then gravity. Holding down turns jump into a platform drop, and suppresses
 * the jump entirely on solid ground.
 */
function applyJump(
  state: PlayerState,
  input: PlayerInput,
  map: CollisionMap,
): { y0: number; vy: number } {
  let y0 = state.y;
  let vy = state.vy;
  if (input.jump && state.onGround) {
    if (!input.down) {
      vy = JUMP_VELOCITY;
    } else if (platformUnderfoot(state, map)) {
      // Nudge the feet just below the top edge so the one-way check lets us fall.
      y0 += PLATFORM_DROP_NUDGE;
    }
  }
  return { y0, vy: Math.min(vy + GRAVITY * DT, MAX_FALL_SPEED) };
}

/**
 * Horizontal move + resolution, clamped to the world. Solids only stop you; vx
 * is unchanged and platforms never block sideways.
 */
function moveX(state: PlayerState, vx: number, y0: number, map: CollisionMap): number {
  let x = state.x + vx * DT;
  for (const solid of map.solids) {
    if (!overlaps(box(x, y0), solid)) continue;
    const s = rectBounds(solid);
    if (vx > 0) x = s.left - PLAYER_HALF_W;
    else if (vx < 0) x = s.right + PLAYER_HALF_W;
  }
  return Math.min(Math.max(x, PLAYER_HALF_W), map.width - PLAYER_HALF_W);
}

/** Where the vertical move left the player, and whether it put them on ground. */
interface VerticalStep {
  y: number;
  vy: number;
  onGround: boolean;
}

/** Vertical move + resolution against solids. A downward hit lands us; either hit zeroes vy. */
function moveY(x: number, y0: number, vy: number, map: CollisionMap): VerticalStep {
  let y = y0 + vy * DT;
  let out = vy;
  let onGround = false;
  for (const solid of map.solids) {
    if (!overlaps(box(x, y), solid)) continue;
    const s = rectBounds(solid);
    if (out > 0) {
      y = s.top - PLAYER_HALF_H;
      onGround = true;
      out = 0;
    } else if (out < 0) {
      y = s.bottom + PLAYER_HALF_H;
      out = 0;
    }
  }
  return { y, vy: out, onGround };
}

/**
 * One-way platforms: support only while falling, and only when the feet crossed
 * the platform's top edge during this tick. `y0` is the pre-move y, so a player
 * already below the edge passes straight through.
 */
function landOnPlatforms(
  x: number,
  y0: number,
  step: VerticalStep,
  map: CollisionMap,
): VerticalStep {
  if (step.vy <= 0) return step;
  const prevFeet = y0 + PLAYER_HALF_H;
  let { y, vy, onGround } = step;
  for (const p of map.platforms) {
    if (!spansRect(x, p)) continue;
    if (prevFeet <= p.y && y + PLAYER_HALF_H >= p.y) {
      y = p.y - PLAYER_HALF_H;
      onGround = true;
      vy = 0;
    }
  }
  return { y, vy, onGround };
}

/**
 * Advance one player by a single fixed tick. Pure: returns a fresh state and
 * never mutates its arguments, so identical inputs always yield identical output.
 */
export function stepPlayer(state: PlayerState, input: PlayerInput, map: CollisionMap): PlayerState {
  const roped = stepRopePhase(state, input, map);
  if (roped.done) return roped.state;
  const s = roped.state;

  const { vx, facing } = horizontalIntent(s, input);
  const { y0, vy } = applyJump(s, input, map);
  const x = moveX(s, vx, y0, map);
  const fall = landOnPlatforms(x, y0, moveY(x, y0, vy, map), map);
  return { x, y: fall.y, vx, vy: fall.vy, facing, onGround: fall.onGround, rope: -1 };
}

/**
 * Replays a packed input batch onto `state`, one tick per byte. This is how the
 * server applies an accepted batch; because the physics is deterministic, a
 * client replaying the same bytes from the same state lands on the same result.
 */
export function replayInputs(
  state: PlayerState,
  packed: Iterable<number>,
  map: CollisionMap,
): PlayerState {
  let s = state;
  for (const byte of packed) s = stepPlayer(s, unpackInput(byte), map);
  return s;
}
