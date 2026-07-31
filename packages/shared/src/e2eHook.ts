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
  local: { x: number; y: number; name: string };
  /** Rendered positions and labels of every remote player currently in the world. */
  remotePlayers: { x: number; y: number; name: string }[];
}

export interface E2EHook {
  snapshot(): E2EWorldSnapshot;
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
    __mapleE2E?: E2EHook;
  }
}
