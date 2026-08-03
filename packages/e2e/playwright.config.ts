// fallow-ignore-file coverage-gaps -- Playwright runner configuration; executed by the test runner against a live stack, outside unit coverage
import { defineConfig, devices } from '@playwright/test';

/**
 * The smoke tests need the full stack. Playwright boots the Vite dev client
 * itself (below); the SpacetimeDB host must already be running with the
 * module published — `spacetime start` + `spacetime publish maple-like
 * --server local --yes`, exactly the README dev workflow (the e2e job in
 * ci.yml does the same with `spacetimedb-cli`).
 */
// fallow-ignore-next-line unused-export -- the Playwright runner loads this config's default export; no in-repo importer exists
export default defineConfig({
  testDir: './test',
  // Generous for a smoke test: CI runners render WebGL in software and pay
  // Vite's cold transform on first load, both well outside the default 30s.
  // Must exceed the sum of a spec's expect.poll budgets (movement-sync
  // allocates 70s across five polls; idle-suppression ~75s across its polls
  // and fixed observation windows) plus entry waits, or a slow-but-healthy
  // run gets cut off mid-poll.
  timeout: 120_000,
  // Every spec shares the one published world, and the sync scenario asserts
  // on how many players are in it — so specs must not run concurrently.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm --filter @maple/client dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
