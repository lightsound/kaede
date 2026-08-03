/**
 * The send-rate token bucket shared by every user-triggered "post something"
 * reducer (chat messages, reactions — 乱用対策): one accepted send per cost
 * interval, with a bounded burst. One core function rather than one copy per
 * send kind, so the rule stays unit-tested in a single place; each kind wraps
 * it with its own constants (evaluateChatSend / evaluateReactionSend) and
 * persists its marker on its own guard table.
 */

export interface SendAllowanceRequest {
  /** Token-bucket marker persisted on the sender's guard row (micros since Unix epoch). */
  allowanceMicros: bigint;
  /** Server wall clock (micros since Unix epoch). */
  nowMicros: bigint;
}

export type SendAllowanceVerdict =
  | {
      ok: true;
      /** The advanced token-bucket marker to persist on the sender's guard row. */
      allowanceMicros: bigint;
    }
  | { ok: false; reason: 'rate-limited' };

/**
 * Pure admission check for one send — the input guard's token bucket
 * (evaluateInputBatch) reshaped for discrete sends. `allowanceMicros` is the
 * point in time up to which the sender's sends are "paid for": each accepted
 * send advances it by `costMicros`, and a marker in the future means the
 * sender is ahead of the sustained rate and is refused until real time
 * catches up. The marker is floored at `burstSends - 1` costs behind
 * `nowMicros`, so an idle sender banks at most one burst — never an
 * unbounded backlog. A sender with no guard row yet passes 0n (the epoch)
 * and gets exactly the full burst.
 */
export function evaluateSendAllowance(
  request: SendAllowanceRequest,
  costMicros: bigint,
  burstSends: number,
): SendAllowanceVerdict {
  const bankFloor = request.nowMicros - costMicros * BigInt(burstSends - 1);
  const marker = request.allowanceMicros < bankFloor ? bankFloor : request.allowanceMicros;
  if (marker > request.nowMicros) return { ok: false, reason: 'rate-limited' };
  return { ok: true, allowanceMicros: marker + costMicros };
}
