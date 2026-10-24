// fallow-ignore-file coverage-gaps -- helpers over the SpacetimeDB reducer context; they only run inside a module host, and the rule itself (the token bucket) is evaluateSendAllowance and its per-feature wrappers in @kaede/shared, unit-tested there

// The send-rate charge every guarded reducer shares (乱用対策): one token
// bucket per feature, each on a guard table of its own.
import type { SendAllowanceRequest, SendAllowanceVerdict } from '@kaede/shared';
import { SenderError } from 'spacetimedb/server';
import type { Ctx } from './world';

/** A send-rate token-bucket marker table (identity → allowanceMicros). */
export type SendGuardTable =
  | Ctx['db']['chatGuard']
  | Ctx['db']['reactionGuard']
  | Ctx['db']['statusGuard']
  | Ctx['db']['portalGuard'];

/** A send-rate guard row, as any marker table returns it. */
type SendGuardRow = NonNullable<ReturnType<SendGuardTable['identity']['find']>>;

/**
 * Charges one send against the sender's token bucket on `guardTable`, or
 * refuses the send (乱用対策 — the Phase 0 input guard's thinking applied
 * to chat, reactions, statuses and portal use). The rule itself is the pure
 * `evaluate` (evaluateChatSend and friends, unit-tested in @kaede/shared);
 * a missing guard row reads as the epoch marker, which the bucket's bank
 * cap turns into exactly one full burst. Lives outside the reducer files
 * (posting.ts was its original home) because the guarded reducers span
 * most of them, and index.ts `export *`s those, while the host refuses
 * non-spacetime entry exports (the world.ts header rule). The marker
 * write-back is split into writeSendAllowance to keep these uncovered
 * arrows under the CRAP budget fallow enforces.
 */
export function chargeSendAllowance(
  ctx: Ctx,
  guardTable: SendGuardTable,
  evaluate: (request: SendAllowanceRequest) => SendAllowanceVerdict,
  reducerName: string,
): void {
  const guard = guardTable.identity.find(ctx.sender);
  const verdict = evaluate({
    allowanceMicros: guard?.allowanceMicros ?? 0n,
    nowMicros: ctx.timestamp.microsSinceUnixEpoch,
  });
  if (!verdict.ok) throw new SenderError(`${reducerName} refused (rate-limited)`);
  writeSendAllowance(ctx, guardTable, guard, verdict.allowanceMicros);
}

/** Writes the advanced marker back: the sender's row, or its lazy first one. */
function writeSendAllowance(
  ctx: Ctx,
  guardTable: SendGuardTable,
  existing: SendGuardRow | null,
  allowanceMicros: bigint,
): void {
  if (existing) {
    guardTable.identity.update({ ...existing, allowanceMicros });
    return;
  }
  guardTable.insert({ identity: ctx.sender, allowanceMicros });
}
