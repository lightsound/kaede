// The recording-pass acquisition flow (ROADMAP Phase 4 増分⑤), pure over
// injected effects so the reuse rule and the mint-then-wait sequencing
// are unit-testable (the acquireCallTicket convention). The pass itself
// is minted server-side (mint_recording_pass) and delivered through the
// RLS-narrowed recording_pass row; this flow decides when the cached row
// still serves (capabilityFresh) and how long to wait for a fresh one
// after asking.
import { capabilityFresh } from '@kaede/shared';

/**
 * How long to wait, after the mint reducer resolved, for the fresh
 * recording_pass row to land in the subscribed cache — and how often to
 * re-check. The row was written before the reducer's ack (that order is
 * the commit), so the subscription usually already delivered it; the
 * retries only cover the tail where the row event is still in flight
 * (the REGISTER_RETRY_DELAY_MS reasoning).
 */
const PASS_ROW_RETRY_DELAY_MS = 250;
const PASS_ROW_RETRIES = 4;

/** What the flow needs injected: the net reads/calls and the clock. */
export interface RecordingPassDeps {
  /** NetApi.ownRecordingPass — the subscribed-cache read. */
  ownRecordingPass(): string | undefined;
  /** NetApi.mintRecordingPass — rejects when the mint is refused. */
  mintRecordingPass(): Promise<void>;
  /** Injected setTimeout, so tests need no timer mocking. */
  delay(ms: number): Promise<void>;
  /** Injected clock (Unix seconds), so tests need no clock mocking. */
  nowSeconds(): number;
}

/** The fresh cached pass, or undefined when a (re-)mint is needed. */
function freshPass(deps: RecordingPassDeps): string | undefined {
  const pass = deps.ownRecordingPass();
  return pass !== undefined && capabilityFresh(pass, deps.nowSeconds()) ? pass : undefined;
}

/**
 * The pass to present to the Worker's recording routes: the cached one
 * while it has enough life left, else a fresh mint awaited off the own
 * row. Throws when the mint is refused (not an approved member, the
 * anchor unprovisioned, rate-limited) or the row never lands — the
 * caller surfaces it as the operation failing, exactly like a Worker
 * refusal would.
 */
export async function acquireRecordingPass(deps: RecordingPassDeps): Promise<string> {
  const cached = freshPass(deps);
  if (cached !== undefined) return cached;
  await deps.mintRecordingPass();
  for (let attempt = 0; attempt <= PASS_ROW_RETRIES; attempt += 1) {
    if (attempt > 0) await deps.delay(PASS_ROW_RETRY_DELAY_MS);
    const pass = freshPass(deps);
    if (pass !== undefined) return pass;
  }
  throw new Error('recording pass: minted but the row never arrived');
}

/** What binding a live pass getter needs from the net facade. */
export interface RecordingPassNet {
  ownRecordingPass(): string | undefined;
  mintRecordingPass(): Promise<void>;
}

/**
 * Binds the flow to the live net methods and the real clock/timer — the
 * RecordingPassGetter (api.ts) the recording surfaces hand their Worker
 * calls (the joinCall deps-binding shape).
 */
export function recordingPassGetterOf(net: RecordingPassNet): () => Promise<string> {
  return () =>
    acquireRecordingPass({
      ownRecordingPass: () => net.ownRecordingPass(),
      mintRecordingPass: () => net.mintRecordingPass(),
      delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      nowSeconds: () => Date.now() / 1000,
    });
}
