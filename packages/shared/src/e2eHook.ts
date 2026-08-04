/**
 * Contract of the read-only hook the client installs on `window` for the
 * Playwright smoke tests (packages/e2e). It lives in shared so the installer
 * (client) and the consumer (e2e specs) compile against the same shape — the
 * two sides are otherwise only coupled at runtime through the browser.
 */
export interface E2EWorldSnapshot {
  /**
   * Applied simulation tick; -1 until the authoritative spawn row has started
   * the local simulation, and again after it stops (own row deleted — kicked
   * or swept), so `tick >= 0` is the "in the world" signal regardless of when
   * the hook itself gets installed.
   */
  tick: number;
  /** Rendered position and label of the local player (world pixels, y-down). */
  local: E2EPlayerSnapshot;
  /** Rendered positions and labels of every remote player currently in the world. */
  remotePlayers: E2EPlayerSnapshot[];
}

/**
 * One rendered player as the hook reports it. `bubble` is the speech-bubble
 * text currently shown above the avatar, `reaction` the emoji reaction, and
 * `status` the composed status line under the avatar (statusLabel in
 * status.ts), each absent while none is — all are canvas-drawn (like
 * positions), so the chat, reaction and status specs can only assert on
 * them through this hook.
 */
export interface E2EPlayerSnapshot {
  x: number;
  y: number;
  name: string;
  bubble?: string;
  reaction?: string;
  status?: string;
}

export interface E2EHook {
  snapshot(): E2EWorldSnapshot;
}

/**
 * Network-layer counters, mutated in place by two writers: the client's
 * network layer (sync.ts — the installer and owner of the object, which
 * bumps the send and row counters) and the notification glue
 * (notify.package's notifier, which bumps dmNotifyDecisions). The second
 * writer holds no reference across calls — it re-reads the window field
 * per decision — and DM rows only flow while a net stack is live, so the
 * object it writes is always the live stack's (never a disposed one's).
 * The outbound pair is what the idle-suppression specs assert
 * on: while a player stands still the ONLY way to see that nothing is sent
 * is to count the sends — position snapshots cannot distinguish "still
 * because idle" from "still because suppressed". The inbound DM counter is
 * the same idea pointed the other way: privacy means rows NOT arriving,
 * which no DOM or canvas assertion can prove (a display filter could hide
 * a delivered row), so the DM spec reads how many rows actually crossed
 * the wire.
 */
export interface E2ENetStats {
  /** submit_inputs calls carrying input ticks (movement batches). */
  inputBatchesSent: number;
  /** Empty submit_inputs calls (the idle-suppression liveness heartbeat). */
  heartbeatsSent: number;
  /** dm_message rows handed to this client (subscription seed + insert events). */
  dmRowsReceived: number;
  /**
   * DM rows this client DECIDED to notify for (shouldNotifyDm returned
   * true), counted before the Notification is constructed and regardless
   * of whether construction succeeds — an OS notification itself is
   * unobservable from a test, so the decision count is what the
   * notification spec asserts on (the dmRowsReceived idea pointed at the
   * outbound side of notifications).
   */
  dmNotifyDecisions: number;
}

declare global {
  interface Window {
    /**
     * The world lives on a WebGL canvas, so browser tests cannot assert on
     * the DOM; this hook exposes rendered positions instead. The client's
     * GameApp installs it in dev builds only. To wait for world entry, poll
     * `snapshot().tick >= 0` — never this hook's mere presence, which is an
     * install-timing implementation detail.
     */
    __kaedeE2E?: E2EHook;
    /**
     * Net-layer counters; installed and torn down by the client's sync.ts,
     * dev builds only. dmNotifyDecisions is written by notify.package's
     * notifier (see the E2ENetStats doc for the lifecycle invariant).
     */
    __kaedeE2ENet?: E2ENetStats;
  }
}
