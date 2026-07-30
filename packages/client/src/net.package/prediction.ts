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
 * Local-player prediction bookkeeping. The client predicts locally and replays
 * un-acked inputs whenever the authoritative state disagrees with our
 * prediction. `startTick` is the authoritative spawn tick.
 */
export function createPrediction(
  deps: PredictionDeps,
  startTick: number,
  nowMs = performance.now(),
) {
  // Prediction bookkeeping. history[t] is the packed input applied to produce
  // predicted[t]; both are pruned once tick t is acknowledged by the server.
  const history = new Map<number, number>();
  const predicted = new Map<number, PlayerState>();
  let currentTick = startTick;
  let ackedTick = startTick;
  let lastSentTick = startTick;
  // Seed the ack-advance clock at creation (the authoritative spawn is "fresh").
  // nowMs is injectable so tests can drive a virtual clock.
  let lastAckAdvanceAt = nowMs;
  let lastFlushMs = 0;

  function flush(now: number): void {
    // Watchdog: if our latest send is still un-acked and has gone quiet, rewind
    // lastSentTick to force a full resend. The server's startTick === row.tick
    // check makes any duplicates harmless.
    if (lastSentTick > ackedTick && now - lastAckAdvanceAt > RESEND_TIMEOUT_MS) {
      lastSentTick = ackedTick;
      lastAckAdvanceAt = now;
    }

    // Send ticks (lastSentTick, currentTick] in chunks of <= INPUT_BATCH_MAX_TICKS.
    let base = lastSentTick;
    while (base < currentTick) {
      const end = Math.min(base + INPUT_BATCH_MAX_TICKS, currentTick);
      const packed: number[] = [];
      for (let t = base + 1; t <= end; t++) packed.push(history.get(t) ?? 0);
      // chunkBase is the tick BEFORE the chunk's first input: the server accepts
      // the batch iff startTick === its current applied-tick count.
      deps.sendBatch(base, new Uint8Array(packed));
      base = end;
    }
    lastSentTick = currentTick;
  }

  function prunePredictionsUpTo(tick: number): void {
    for (const t of history.keys()) if (t <= tick) history.delete(t);
    for (const t of predicted.keys()) if (t <= tick) predicted.delete(t);
  }

  return {
    // Outbound: collect each predicted tick, and flush pending inputs on the
    // INPUT_FLUSH_INTERVAL_MS cadence (driven by the local tick timing, like
    // the old throttle).
    onTick(state: PlayerState, tick: number, packedInput: number, nowMs: number): void {
      currentTick = tick;
      history.set(tick, packedInput);
      predicted.set(tick, state);

      // Bound history memory: drop the oldest entries beyond the cap.
      while (history.size > PREDICTION_HISTORY_MAX_TICKS) {
        const oldest = tick - history.size + 1;
        history.delete(oldest);
        predicted.delete(oldest);
      }

      if (nowMs - lastFlushMs < INPUT_FLUSH_INTERVAL_MS) return;
      lastFlushMs = nowMs;
      flush(nowMs);
    },

    /** Ack path: an own-row update IS the acknowledgement (ackTick = applied). */
    onAck(authoritative: PlayerState, ackTick: number, nowMs: number): void {
      const ack = ackTick;
      if (ack > ackedTick) lastAckAdvanceAt = nowMs;

      const mine = predicted.get(ack);
      if (mine && sameState(mine, authoritative)) {
        // Prediction matched: just advance the ack horizon.
        ackedTick = ack;
        prunePredictionsUpTo(ack);
        return;
      }

      // Reconcile: the server diverged (or we lost the predicted state). Replay
      // un-acked inputs from the authoritative state forward to currentTick.
      if (ack < currentTick && !history.has(ack + 1)) {
        // The ack predates everything we still keep: we can't replay the missing
        // inputs. Hard reset to the authoritative state and start over from there.
        history.clear();
        predicted.clear();
        currentTick = ack;
        ackedTick = ack;
        lastSentTick = ack;
        deps.resetLocal(authoritative, ack);
        return;
      }

      let s = authoritative;
      for (let t = ack + 1; t <= currentTick; t++) {
        s = stepPlayer(s, unpackInput(history.get(t) ?? 0), DEFAULT_MAP);
        predicted.set(t, s);
      }
      deps.resetLocal(s, currentTick);
      ackedTick = ack;
      prunePredictionsUpTo(ack);
    },
  };
}
