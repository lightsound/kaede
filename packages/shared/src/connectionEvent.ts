// The connection-event log's rules (ROADMAP Phase 2 エラー監視 ②): what the
// server records about connects/disconnects lives in a PRIVATE table
// (connection_event in the server schema), because the one metric that
// cannot be measured from the browser is "the client dropped and could not
// come back" — when the network is down, the client's beacon cannot leave
// the machine either (ADR §8.1-2). The pure pieces here are shared so the
// retention cap and the disconnect classification are unit-tested.

/**
 * How many connection events the server keeps (保持方針). The table is
 * private — never broadcast, so rows cost storage only — but an event log
 * with no cap grows forever on a table nobody sweeps. At dogfooding scale
 * (~20 people × a few dozen connect/disconnect pairs a day) this holds
 * roughly one to two weeks of history, enough for the reconnect-failure-rate
 * SQL the log exists for; long-horizon analysis belongs in PostHog events,
 * not this table.
 */
export const CONNECTION_EVENT_MAX = 10_000;

/**
 * How recently an announce_idle_suspend must precede its disconnect to count
 * as the announced (deliberate) cut. The announce and the close normally land
 * milliseconds apart — the client sends the reducer call and closes the same
 * socket — so a generous minute absorbs slow links while an intent row
 * orphaned by a bug (announced, then never disconnected) cannot mislabel a
 * genuinely unexpected drop hours later.
 */
export const DISCONNECT_INTENT_FRESH_MS = 60_000;

/**
 * Why a connection ended, as the server can know it:
 * - 'idle': the client announced the cut beforehand (the idle guard's
 *   deliberate suspension after IDLE_DISCONNECT_MS without input — idle.ts).
 *   A normal, expected event in an always-open office.
 * - 'unannounced': everything else — a network drop, a crashed tab, a closed
 *   laptop, but also a plainly closed tab (no reliable beacon exists there).
 * Distinguishing the two is what keeps the reconnect-failure metric honest:
 * idle cuts are the majority of disconnects and are not failures (ADR §8.1).
 */
export type DisconnectReason = 'idle' | 'unannounced';

/**
 * Classifies a disconnect from the age of the sender connection's intent row
 * (undefined = no announce was filed). Pure so the freshness rule is
 * unit-tested; the server computes the age from two of its own timestamps.
 */
export function disconnectReasonFrom(intentAgeMs: number | undefined): DisconnectReason {
  if (intentAgeMs === undefined) return 'unannounced';
  return intentAgeMs <= DISCONNECT_INTENT_FRESH_MS ? 'idle' : 'unannounced';
}
