/**
 * Contract of the read-only hook the client installs on `window` for the
 * Playwright smoke tests (packages/e2e). It lives in shared so the installer
 * (client) and the consumer (e2e specs) compile against the same shape — the
 * two sides are otherwise only coupled at runtime through the browser.
 */
export interface E2EWorldSnapshot {
  /** Rendered position of the local player (world pixels, y-down). */
  local: { x: number; y: number };
  /** Rendered positions of every remote player currently in the world. */
  remotePlayers: { id: string; name: string; x: number; y: number }[];
}

export interface E2EHook {
  snapshot(): E2EWorldSnapshot;
}

declare global {
  interface Window {
    /**
     * The world lives on a WebGL canvas, so browser tests cannot assert on
     * the DOM; this hook exposes rendered positions instead. The client's
     * GameApp.start() installs it in dev builds once the authoritative spawn
     * row has started the local simulation, so its presence doubles as the
     * "entered the world" signal.
     */
    __mapleE2E?: E2EHook;
  }
}
