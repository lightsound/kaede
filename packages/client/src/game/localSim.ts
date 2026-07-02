import {
  DEFAULT_MAP,
  DT,
  type Facing,
  type PlayerInput,
  type PlayerState,
  SPAWN_X,
  SPAWN_Y,
  stepPlayer,
} from '@maple/shared';
import { correctionOffset, decayOffset, type Vec2 } from './smoothing';

/** Cap on how much wall-clock time one frame may feed the accumulator. */
const MAX_FRAME = 0.25;

/** Where to draw the local player this frame, after interpolation + smoothing. */
export interface RenderPose {
  x: number;
  y: number;
  facing: Facing;
}

/**
 * Fixed-timestep simulation of the local player, plus the render-side
 * interpolation/smoothing bookkeeping. Pure state machine: no Pixi, no DOM, so
 * it is unit-testable. The simulation state (prev/curr) always holds the exact
 * corrected value; the decaying offset only shifts the rendered pose, never
 * the physics.
 */
export interface LocalSim {
  /**
   * Begin stepping from `state` at `tick`. Until this is called, advance()
   * renders but never steps physics or fires onTick, so the client waits for
   * the authoritative spawn row.
   */
  start(state: PlayerState, tick: number): void;
  /**
   * Reconciliation hook: snap prev=curr=state and the tick counter to `tick`.
   * The visual error (where we rendered vs. the corrected state) is carried
   * into the smoothing offset so the sprite eases over instead of popping.
   */
  reset(state: PlayerState, tick: number): void;
  /**
   * Accumulate `deltaMS`, step zero or more fixed ticks (sampling input and
   * firing onTick per step), then decay the smoothing offset. Call once per
   * frame, before renderPose().
   */
  advance(deltaMS: number, sample: () => PlayerInput): void;
  /** The interpolated + smoothed pose to draw this frame. */
  renderPose(): RenderPose;
}

interface SimState {
  prev: PlayerState;
  curr: PlayerState;
  /** Wall-clock time (s) accumulated toward the next fixed tick. */
  acc: number;
  /** Simulation is gated until start(): tick < 0 means "not yet running". */
  tick: number;
  offset: Vec2;
}

const SPAWN_STATE: PlayerState = {
  x: SPAWN_X,
  y: SPAWN_Y,
  vx: 0,
  vy: 0,
  facing: 1,
  onGround: false,
  rope: -1,
};

/** prev→curr interpolation at the current accumulator, plus the offset. */
function renderedNow(s: SimState): Vec2 {
  const alpha = s.acc / DT;
  return {
    x: s.prev.x + (s.curr.x - s.prev.x) * alpha + s.offset.x,
    y: s.prev.y + (s.curr.y - s.prev.y) * alpha + s.offset.y,
  };
}

export function createLocalSim(
  onTick: (state: PlayerState, tick: number, input: PlayerInput) => void,
): LocalSim {
  const s: SimState = {
    prev: SPAWN_STATE,
    curr: SPAWN_STATE,
    acc: 0,
    tick: -1,
    offset: { x: 0, y: 0 },
  };

  return {
    start(state, t) {
      s.prev = s.curr = state;
      s.tick = t;
      s.acc = 0; // clamp so the first running frame doesn't replay a burst
      s.offset = { x: 0, y: 0 };
    },
    reset(state, t) {
      // Carry the visual error: where we render now (incl. the live offset) vs.
      // the corrected state. prev/curr jump to the truth; the sprite eases over.
      const renderedBefore = renderedNow(s);
      s.prev = s.curr = state;
      s.tick = t;
      s.offset = correctionOffset(renderedBefore, { x: state.x, y: state.y });
    },
    advance(deltaMS, sample) {
      if (s.tick < 0) {
        s.acc = 0; // never pre-accumulate before the sim starts
      } else {
        s.acc += Math.min(deltaMS / 1000, MAX_FRAME);
      }
      while (s.acc >= DT) {
        s.prev = s.curr;
        const input = sample();
        s.curr = stepPlayer(s.curr, input, DEFAULT_MAP);
        s.tick += 1;
        s.acc -= DT;
        onTick(s.curr, s.tick, input);
      }
      s.offset = decayOffset(s.offset, deltaMS);
    },
    renderPose() {
      const p = renderedNow(s);
      return { x: p.x, y: p.y, facing: s.curr.facing };
    },
  };
}
