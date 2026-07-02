import {
  DEFAULT_MAP,
  INPUT_BATCH_MAX_TICKS,
  INPUT_FLUSH_INTERVAL_MS,
  type PlayerState,
  PREDICTION_HISTORY_MAX_TICKS,
  RESEND_TIMEOUT_MS,
  stepPlayer,
  unpackInput,
} from '@maple/shared';

/** Transport + sim hooks the prediction loop drives, decoupled from SpacetimeDB/Pixi. */
export interface PredictionDeps {
  /** Fire-and-forget: send one input batch starting at startTick (the tick BEFORE the chunk's first input). */
  sendBatch(startTick: number, packed: Uint8Array): void;
  /** Snap the game sim to an authoritative state at tick (hard-reset fallback). */
  resetLocal(state: PlayerState, tick: number): void;
}

const sameState = (a: PlayerState, b: PlayerState): boolean =>
  a.x === b.x &&
  a.y === b.y &&
  a.vx === b.vx &&
  a.vy === b.vy &&
  a.facing === b.facing &&
  a.onGround === b.onGround &&
  a.rope === b.rope;

/**
 * Prediction bookkeeping. history[t] is the packed input applied to produce
 * predicted[t]; both are pruned once tick t is acknowledged by the server.
 */
interface PredictionState {
  history: Map<number, number>;
  predicted: Map<number, PlayerState>;
  currentTick: number;
  ackedTick: number;
  lastSentTick: number;
  lastAckAdvanceAt: number;
  lastFlushMs: number;
}

function flush(st: PredictionState, deps: PredictionDeps, now: number): void {
  // Watchdog: if our latest send is still un-acked and has gone quiet, rewind
  // lastSentTick to force a full resend. The server's startTick === row.tick
  // check makes any duplicates harmless.
  if (st.lastSentTick > st.ackedTick && now - st.lastAckAdvanceAt > RESEND_TIMEOUT_MS) {
    st.lastSentTick = st.ackedTick;
    st.lastAckAdvanceAt = now;
  }

  // Send ticks (lastSentTick, currentTick] in chunks of <= INPUT_BATCH_MAX_TICKS.
  let base = st.lastSentTick;
  while (base < st.currentTick) {
    const end = Math.min(base + INPUT_BATCH_MAX_TICKS, st.currentTick);
    const packed: number[] = [];
    for (let t = base + 1; t <= end; t++) packed.push(st.history.get(t) ?? 0);
    // chunkBase is the tick BEFORE the chunk's first input: the server accepts
    // the batch iff startTick === its current applied-tick count.
    deps.sendBatch(base, new Uint8Array(packed));
    base = end;
  }
  st.lastSentTick = st.currentTick;
}

function prunePredictionsUpTo(st: PredictionState, tick: number): void {
  for (const t of st.history.keys()) if (t <= tick) st.history.delete(t);
  for (const t of st.predicted.keys()) if (t <= tick) st.predicted.delete(t);
}

/**
 * Reconcile after a diverging ack: the server disagreed (or we lost the
 * predicted state). Replays un-acked inputs from the authoritative state
 * forward to currentTick, or hard-resets when the replay inputs are gone.
 */
function reconcile(
  st: PredictionState,
  deps: PredictionDeps,
  authoritative: PlayerState,
  ack: number,
): void {
  if (ack < st.currentTick && !st.history.has(ack + 1)) {
    // The ack predates everything we still keep: we can't replay the missing
    // inputs. Hard reset to the authoritative state and start over from there.
    st.history.clear();
    st.predicted.clear();
    st.currentTick = ack;
    st.ackedTick = ack;
    st.lastSentTick = ack;
    deps.resetLocal(authoritative, ack);
    return;
  }

  let s = authoritative;
  for (let t = ack + 1; t <= st.currentTick; t++) {
    s = stepPlayer(s, unpackInput(st.history.get(t) ?? 0), DEFAULT_MAP);
    st.predicted.set(t, s);
  }
  deps.resetLocal(s, st.currentTick);
  st.ackedTick = ack;
  prunePredictionsUpTo(st, ack);
}

/**
 * Local-player prediction bookkeeping. The client predicts locally and replays
 * un-acked inputs whenever the authoritative state disagrees with our
 * prediction. `startTick` is the authoritative spawn tick.
 */
export function createPrediction(
  deps: PredictionDeps,
  startTick: number,
  nowMs = performance.now(),
) {
  const st: PredictionState = {
    history: new Map(),
    predicted: new Map(),
    currentTick: startTick,
    ackedTick: startTick,
    lastSentTick: startTick,
    // Seed the ack-advance clock at creation (the authoritative spawn is "fresh").
    // nowMs is injectable so tests can drive a virtual clock.
    lastAckAdvanceAt: nowMs,
    lastFlushMs: 0,
  };

  return {
    // Outbound: collect each predicted tick, and flush pending inputs on the
    // INPUT_FLUSH_INTERVAL_MS cadence (driven by the local tick timing, like
    // the old throttle).
    onTick(state: PlayerState, tick: number, packedInput: number, nowMs: number): void {
      st.currentTick = tick;
      st.history.set(tick, packedInput);
      st.predicted.set(tick, state);

      // Bound history memory: drop the oldest entries beyond the cap.
      while (st.history.size > PREDICTION_HISTORY_MAX_TICKS) {
        const oldest = tick - st.history.size + 1;
        st.history.delete(oldest);
        st.predicted.delete(oldest);
      }

      if (nowMs - st.lastFlushMs < INPUT_FLUSH_INTERVAL_MS) return;
      st.lastFlushMs = nowMs;
      flush(st, deps, nowMs);
    },

    /** Ack path: an own-row update IS the acknowledgement (ackTick = applied). */
    onAck(authoritative: PlayerState, ackTick: number, nowMs: number): void {
      if (ackTick > st.ackedTick) st.lastAckAdvanceAt = nowMs;

      const mine = st.predicted.get(ackTick);
      if (mine && sameState(mine, authoritative)) {
        // Prediction matched: just advance the ack horizon.
        st.ackedTick = ackTick;
        prunePredictionsUpTo(st, ackTick);
        return;
      }

      reconcile(st, deps, authoritative, ackTick);
    },
  };
}
