/**
 * Tiny shared animation math for the procedural rigs. Kept in one place so the
 * character and mob factories don't each re-implement the same sine-bob loop
 * (fallow's dupes check is pair-sensitive, and copy-pasted oscillators would
 * trip it). No Pixi here: pure number helpers, easy to reason about.
 */

const TWO_PI = Math.PI * 2;

/**
 * A free-running phase accumulator in [0, 2π). `advance` adds an angular step
 * derived from elapsed time and a caller-chosen rate, wrapping so the phase
 * never grows without bound (important for a long-lived rig). Speed-driven
 * cadence is achieved by feeding a rate proportional to |velocity|.
 */
export interface Phase {
  /** Current phase in radians, always wrapped into [0, 2π). */
  value: number;
  /** Advance by `radians` (already time-scaled by the caller) and wrap. */
  advance(radians: number): void;
}

export function createPhase(initial = 0): Phase {
  const p: Phase = {
    value: initial,
    advance(radians: number) {
      p.value = (p.value + radians) % TWO_PI;
      // % can return a small negative for negative input; normalize to [0, 2π).
      if (p.value < 0) p.value += TWO_PI;
    },
  };
  return p;
}

/**
 * A self-advancing oscillator at a FIXED period (ms): idle bobs, slime squash,
 * mushroom waddle. Returns sin(phase) in [-1, 1]. Unlike Phase (whose rate the
 * caller varies with speed), this one ticks itself by dtMs.
 */
export interface Oscillator {
  /** Advance the internal phase by dtMs and return the new sine value. */
  tick(dtMs: number): number;
  /** The last computed sine value without advancing (for counter-phase reads). */
  readonly sin: number;
}

export function createOscillator(periodMs: number, initialPhase = 0): Oscillator {
  let phase = initialPhase;
  let sin = Math.sin(phase);
  const ratePerMs = TWO_PI / periodMs;
  return {
    tick(dtMs: number) {
      phase = (phase + ratePerMs * dtMs) % TWO_PI;
      sin = Math.sin(phase);
      return sin;
    },
    get sin() {
      return sin;
    },
  };
}
