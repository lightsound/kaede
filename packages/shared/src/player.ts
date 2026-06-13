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
  PORTAL_RANGE_X,
  PORTAL_RANGE_Y,
  ROPE_GRAB_RANGE,
  ROPE_JUMP_VELOCITY,
} from './constants';
import { ATTACK_COOLDOWN_TICKS } from './combat';
import { overlaps, rectBounds, type AABB } from './physics';
import type { CollisionMap, Facing, Portal, PlayerInput, PlayerState, Rect } from './types';

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

/** Build a PlayerState from a player row's dynamic columns. */
export function stateFromRow(r: {
  x: number;
  y: number;
  vx: number;
  vy: number;
  facing: number;
  onGround: boolean;
  rope: number;
  attackCooldown: number;
  mapId: number;
}): PlayerState {
  return {
    x: r.x,
    y: r.y,
    vx: r.vx,
    vy: r.vy,
    facing: toFacing(r.facing),
    onGround: r.onGround,
    rope: r.rope,
    attackCooldown: r.attackCooldown,
    mapId: r.mapId,
  };
}

/**
 * True when a player centered at (x, y) is within a portal's activation box.
 * Shared by stepPlayer (to fire travel) and the ping-pong invariant test (to
 * assert no landing spot sits inside any destination portal's box), so the
 * range geometry lives in exactly one place.
 */
export function portalInRange(x: number, y: number, p: Portal): boolean {
  return Math.abs(x - p.x) <= PORTAL_RANGE_X && Math.abs(y - p.y) <= PORTAL_RANGE_Y;
}

/**
 * Whether a swing fires THIS tick, evaluated against the PRE-step state. A swing
 * needs the attack input, a ready cooldown, and the player not on a rope (no
 * mid-climb swings). Both client prediction and server replay call this with the
 * same pre-step state, so the "did it fire" decision stays deterministic.
 */
export function attackFires(state: PlayerState, input: PlayerInput): boolean {
  return input.attack && state.attackCooldown === 0 && state.rope === -1;
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
 * Portal travel, checked FIRST (before rope/climb): a grounded player pressing
 * up while standing on a portal teleports to the target map/coords; returns the
 * arrival state, or undefined when no portal fires (proceed to climb/step).
 *
 * INVARIANTS: onGround=false on arrival means a held up cannot re-trigger until
 * the player lands; combined with the landing-offset rule (a target never sits
 * inside a destination portal's box), a held up key can't ping-pong the player
 * between maps. The target map is the only place mapId changes; every other path
 * carries state.mapId unchanged.
 */
function tryPortal(
  state: PlayerState,
  input: PlayerInput,
  map: CollisionMap,
  attackCooldown: number,
): PlayerState | undefined {
  if (!input.up || !state.onGround) return undefined;
  for (const portal of map.portals) {
    if (!portalInRange(state.x, state.y, portal)) continue;
    return {
      x: portal.targetX,
      y: portal.targetY,
      vx: 0,
      vy: 0,
      facing: state.facing,
      onGround: false,
      rope: -1,
      attackCooldown,
      mapId: portal.targetMap,
    };
  }
  return undefined;
}

/**
 * Outcome of the climb step. `undefined` means the rope did nothing this tick,
 * so the caller runs the regular ground/air step on the ORIGINAL state. A plain
 * PlayerState is a finished tick (early return). A `{ fallthrough }` carries the
 * MODIFIED state that the regular step must still run THIS tick: jumping off a
 * rope with a direction detaches the rope (rope=-1, vy=ROPE_JUMP_VELOCITY,
 * onGround=false) yet must also apply the horizontal input the same tick.
 */
type ClimbResult = PlayerState | { fallthrough: PlayerState } | undefined;

/**
 * Climbing: up/down drive y directly; gravity and collision are suspended.
 * Handles both the rope-attached branch and the rope-grab path. See ClimbResult
 * for the three outcomes.
 */
function climbStep(
  state: PlayerState,
  input: PlayerInput,
  map: CollisionMap,
  attackCooldown: number,
): ClimbResult {
  const rope = state.rope >= 0 ? map.ropes[state.rope] : undefined;
  if (rope) {
    if (input.jump && (input.left || input.right)) {
      // Jumping off needs a direction (plain jump keeps climbing). Fall through
      // to the regular step so the horizontal input takes effect this tick.
      return { fallthrough: { ...state, rope: -1, vy: ROPE_JUMP_VELOCITY, onGround: false } };
    }
    const dir = (input.down ? 1 : 0) - (input.up ? 1 : 0);
    const y = state.y + dir * CLIMB_SPEED * DT;
    if (y < rope.top) {
      // Climbed past the top: step up onto whatever the rope hangs from.
      return {
        x: rope.x,
        y: rope.top - PLAYER_HALF_H,
        vx: 0,
        vy: 0,
        facing: state.facing,
        onGround: true,
        rope: -1,
        attackCooldown,
        mapId: state.mapId,
      };
    }
    if (y > rope.bottom) {
      // Slid past the bottom: let go and fall.
      return { x: rope.x, y: rope.bottom, vx: 0, vy: 0, facing: state.facing, onGround: false, rope: -1, attackCooldown, mapId: state.mapId };
    }
    return { x: rope.x, y, vx: 0, vy: 0, facing: state.facing, onGround: false, rope: state.rope, attackCooldown, mapId: state.mapId };
  }
  if (input.up || input.down) {
    const grabbed = grabRope(state, input, map);
    if (grabbed >= 0) {
      const r = map.ropes[grabbed];
      const y = Math.min(Math.max(state.y, r.top), r.bottom);
      return { x: r.x, y, vx: 0, vy: 0, facing: state.facing, onGround: false, rope: grabbed, attackCooldown, mapId: state.mapId };
    }
  }
  return undefined;
}

/** The horizontal half of a regular step: the new x, vx, facing, and vy/y0. */
interface HorizontalStep {
  x: number;
  vx: number;
  facing: Facing;
  /** vy after the jump/drop decision and the gravity clamp. */
  vy: number;
  /** y BEFORE the vertical move (the platform-drop nudge folds into it here). */
  y0: number;
}

/**
 * The horizontal half of a regular ground/air step: pick vx/facing, apply the
 * jump / drop-through decision, clamp gravity, then sweep x against solids and
 * the world bounds. `y0` is the (possibly drop-nudged) pre-vertical-move y, used
 * by both the solids sweep here and the vertical resolve next.
 */
function horizontalStep(state: PlayerState, input: PlayerInput, map: CollisionMap): HorizontalStep {
  const vx = ((input.right ? 1 : 0) - (input.left ? 1 : 0)) * MOVE_SPEED;
  let facing: Facing = state.facing;
  if (vx > 0) facing = 1;
  else if (vx < 0) facing = -1;

  // Jump / drop-through. Holding down turns jump into a platform drop, and
  // suppresses the jump entirely on solid ground.
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
  vy = Math.min(vy + GRAVITY * DT, MAX_FALL_SPEED);

  // Horizontal move + resolution. Solids only stop you; vx is unchanged and
  // platforms never block sideways.
  let x = state.x + vx * DT;
  for (const solid of map.solids) {
    if (!overlaps(box(x, y0), solid)) continue;
    const s = rectBounds(solid);
    if (vx > 0) x = s.left - PLAYER_HALF_W;
    else if (vx < 0) x = s.right + PLAYER_HALF_W;
  }
  x = Math.min(Math.max(x, PLAYER_HALF_W), map.width - PLAYER_HALF_W);

  return { x, vx, facing, vy, y0 };
}

/** The resolved vertical position after the move: final y, vy, and onGround. */
interface VerticalResolve {
  y: number;
  vy: number;
  onGround: boolean;
}

/**
 * The vertical half of a regular step: move from y0 by vy, resolve against
 * solids (a downward hit lands us; either hit zeroes vy), then let one-way
 * platforms support the player — but only while falling and only when the feet
 * crossed the platform's top edge during this tick.
 */
function verticalResolve(x: number, y0: number, vy: number, map: CollisionMap): VerticalResolve {
  let y = y0 + vy * DT;
  let onGround = false;
  for (const solid of map.solids) {
    if (!overlaps(box(x, y), solid)) continue;
    const s = rectBounds(solid);
    if (vy > 0) {
      y = s.top - PLAYER_HALF_H;
      onGround = true;
      vy = 0;
    } else if (vy < 0) {
      y = s.bottom + PLAYER_HALF_H;
      vy = 0;
    }
  }

  // One-way platforms: support only while falling, and only when the feet
  // crossed the platform's top edge during this tick.
  if (vy > 0) {
    const prevFeet = y0 + PLAYER_HALF_H;
    for (const p of map.platforms) {
      if (!spansRect(x, p)) continue;
      if (prevFeet <= p.y && y + PLAYER_HALF_H >= p.y) {
        y = p.y - PLAYER_HALF_H;
        onGround = true;
        vy = 0;
      }
    }
  }

  return { y, vy, onGround };
}

/**
 * Advance one player by a single fixed tick. Pure: returns a fresh state and
 * never mutates its arguments, so identical inputs always yield identical output.
 *
 * `maps` is the full map list; this tick acts on `maps[state.mapId]`. Portal
 * travel is just another step here, so client prediction and server replay
 * switch maps in perfect lockstep — no separate teleport reducer, no special
 * reconciliation, and the client cannot fake a destination.
 */
export function stepPlayer(
  state: PlayerState,
  input: PlayerInput,
  maps: readonly CollisionMap[],
): PlayerState {
  const map = maps[state.mapId];

  // Post-step cooldown, carried into EVERY returned state below so the value is
  // never dropped on a climbing/rope/portal early return. A swing this tick
  // (evaluated on the pre-step state) latches the full cooldown; otherwise it
  // decays by one toward 0. Attacking is purely a combat clock and never alters
  // movement.
  const attackCooldown = attackFires(state, input)
    ? ATTACK_COOLDOWN_TICKS
    : Math.max(0, state.attackCooldown - 1);

  const portaled = tryPortal(state, input, map, attackCooldown);
  if (portaled) return portaled;

  // Climbing may finish the tick outright, or yield a fall-through state (jump
  // off a rope with a direction) that the regular step still runs THIS tick.
  const climbed = climbStep(state, input, map, attackCooldown);
  let stepState = state;
  if (climbed !== undefined) {
    if ('fallthrough' in climbed) stepState = climbed.fallthrough;
    else return climbed;
  }

  const h = horizontalStep(stepState, input, map);
  const v = verticalResolve(h.x, h.y0, h.vy, map);

  return {
    x: h.x,
    y: v.y,
    vx: h.vx,
    vy: v.vy,
    facing: h.facing,
    onGround: v.onGround,
    rope: -1,
    attackCooldown,
    mapId: state.mapId,
  };
}
