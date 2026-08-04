import {
  DEFAULT_MAP,
  evaluateSendWindow,
  INPUT_BATCH_MAX_TICKS,
  INPUT_FLUSH_INTERVAL_MS,
  type PlayerState,
  PREDICTION_HISTORY_MAX_TICKS,
  RESEND_TIMEOUT_MS,
  stepPlayer,
  unpackInput,
} from '@kaede/shared';

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
 * Local-player prediction bookkeeping. The client predicts locally at the
 * full tick rate and replays un-acked inputs whenever the authoritative
 * state disagrees with our prediction. `startTick`/`startState` are the
 * authoritative spawn tick and state.
 *
 * Outbound traffic is where the idle suppression lives (ROADMAP Phase 2):
 * pending ticks flush every INPUT_FLUSH_INTERVAL_MS, but a flush whose
 * window the send gate rules a no-op (no input, quiescent, fully acked —
 * see evaluateSendWindow in @kaede/shared) is SKIPPED: nothing is sent, and
 * the sent/acked horizon advances virtually past the window. The server
 * never hears about those ticks; when input resumes, the next batch's
 * startTick runs past the server's row tick and the server accepts the gap
 * because its row state is quiescent (evaluateInputBatch). Local prediction
 * is untouched — only network sends are gated.
 */
export function createPrediction(
  deps: PredictionDeps,
  startTick: number,
  startState: PlayerState,
  nowMs = performance.now(),
) {
  // Prediction bookkeeping. history[t] is the packed input applied to produce
  // predicted[t]; both are pruned once tick t is acknowledged by the server.
  const history = new Map<number, number>();
  const predicted = new Map<number, PlayerState>();
  let currentTick = startTick;
  let ackedTick = startTick;
  let lastSentTick = startTick;
  // The state at lastSentTick: what the server will hold once everything
  // sent so far is applied, and therefore what it replays the next window
  // from. The send gate rules on THIS state, not the current one: a window
  // may end quiescent (just landed) while its start was mid-air, and going
  // silent then would leave the server's row frozen in the air.
  let lastSentState = startState;
  // The latest authoritative state, for rewinding lastSentState when the
  // resend watchdog rewinds lastSentTick to ackedTick.
  let ackedState = startState;
  // Seed the ack-advance clock at creation (the authoritative spawn is "fresh").
  // nowMs is injectable so tests can drive a virtual clock.
  let lastAckAdvanceAt = nowMs;
  let lastFlushMs = 0;

  /** Any real input in the pending window ((lastSentTick, currentTick])? */
  function pendingWindowHasInput(): boolean {
    for (let t = lastSentTick + 1; t <= currentTick; t++) {
      if ((history.get(t) ?? 0) !== 0) return true;
    }
    return false;
  }

  function flush(now: number): void {
    // Watchdog: if our latest send is still un-acked and has gone quiet, rewind
    // lastSentTick to force a full resend. The server refuses re-covered ticks
    // as stale, so any duplicates are harmless.
    if (lastSentTick > ackedTick && now - lastAckAdvanceAt > RESEND_TIMEOUT_MS) {
      lastSentTick = ackedTick;
      lastSentState = ackedState;
      lastAckAdvanceAt = now;
    }
    if (lastSentTick >= currentTick) return;

    // 送信ゲート: この判定が「静止中 0 calls/秒」を作る(条件と根拠は
    // evaluateSendWindow を参照)。skip はウィンドウ全 tick が確認済み
    // 静止状態上の no-op であることの証明なので、送らずに送信済み/ack 済み
    // 位置を進めてよい — サーバー側はギャップとして受理する。
    const verdict = evaluateSendWindow({
      anyInput: pendingWindowHasInput(),
      windowStartState: lastSentState,
      fullyAcked: lastSentTick === ackedTick,
    });
    if (verdict === 'skip') {
      lastSentTick = currentTick;
      ackedTick = currentTick;
      // The virtual advance counts as ack progress for the watchdog too:
      // without this, the first flush after a long-suppressed stretch sees a
      // minutes-old lastAckAdvanceAt and needlessly resends the resume batch
      // (harmless — the server refuses duplicates — but wasted calls).
      lastAckAdvanceAt = now;
      prunePredictionsUpTo(currentTick);
      return;
    }

    // Send ticks (lastSentTick, currentTick] in chunks of <= INPUT_BATCH_MAX_TICKS.
    let base = lastSentTick;
    while (base < currentTick) {
      const end = Math.min(base + INPUT_BATCH_MAX_TICKS, currentTick);
      const packed: number[] = [];
      for (let t = base + 1; t <= end; t++) packed.push(history.get(t) ?? 0);
      // chunkBase is the tick BEFORE the chunk's first input: the server
      // accepts the batch iff startTick === its applied-tick count, or runs
      // past it over a quiescent gap.
      deps.sendBatch(base, new Uint8Array(packed));
      base = end;
    }
    lastSentTick = currentTick;
    // Always present: flush only runs from onTick, which just recorded
    // predicted[currentTick]. The guard is only for Map.get's undefined type.
    const sentState = predicted.get(currentTick);
    if (sentState) lastSentState = sentState;
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
      // Not an advance: a heartbeat rewrites the row (updatedAt) without
      // moving its tick, and the send gate itself advances ackedTick
      // virtually past ticks the server never saw. Reconciling against a
      // stale tick would replay pruned history; the state cannot have
      // changed (only inputs move it, and those ticks are settled), so
      // there is nothing to do.
      if (ack <= ackedTick) return;
      lastAckAdvanceAt = nowMs;
      ackedState = authoritative;

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
        lastSentState = authoritative;
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
      // Refresh the state the send gate rules on: the server's real state at
      // the ack replaces whatever we had predicted. Past the ack the replay
      // loop above just rewrote predicted[], so lastSentTick's entry (when
      // still ahead of the ack) is the corrected one; at or behind the ack,
      // the authoritative state itself is the server's current truth (a
      // behind-the-ack lastSentTick only exists after a watchdog rewind that
      // a late ack overtook, and the next rewind re-syncs it anyway).
      lastSentState =
        (lastSentTick > ack ? predicted.get(lastSentTick) : undefined) ?? authoritative;
      prunePredictionsUpTo(ack);
    },
  };
}
