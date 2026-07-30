// fallow-ignore-file coverage-gaps -- Playwright E2E spec; drives real browsers against a live SpacetimeDB host, outside unit coverage
import { type E2EWorldSnapshot, MOVE_SPEED } from '@maple/shared';
import { expect, type Page, test } from '@playwright/test';

function snapshot(page: Page): Promise<E2EWorldSnapshot> {
  return page.evaluate(() => {
    const hook = window.__mapleE2E;
    if (!hook) throw new Error('__mapleE2E hook is not installed');
    return hook.snapshot();
  });
}

/**
 * Guest entry: load the client and wait until the authoritative spawn row has
 * started the local simulation (covers connect → join → own-row round trip).
 * The client installs the hook at that exact moment, so its presence is the
 * "entered the world" signal.
 */
async function enterWorld(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => window.__mapleE2E !== undefined);
}

const remoteCount = async (page: Page) => (await snapshot(page)).remotePlayers.length;
/** The single remote player's x, or undefined during a transient empty list. */
const remoteX = async (page: Page) => (await snapshot(page)).remotePlayers[0]?.x;

// Hold ArrowRight for WALK_MS on the flat ground around the spawn. Half the
// ideal distance keeps the assertion far from both "did not move" and the
// tick jitter of a loaded CI runner.
const WALK_MS = 1000;
const MIN_WALK_DISTANCE = (MOVE_SPEED * WALK_MS) / 1000 / 2;

test('ゲスト2ブラウザで入場すると互いに見え、移動が同期する', async ({ browser }) => {
  // Two isolated contexts = two tabs with their own sessionStorage, so the
  // server sees two distinct guest identities.
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  await enterWorld(pageA);
  await enterWorld(pageB);

  // Entry is mutual: each client renders exactly the other player.
  await expect.poll(() => remoteCount(pageA), { timeout: 15_000 }).toBe(1);
  await expect.poll(() => remoteCount(pageB), { timeout: 15_000 }).toBe(1);

  const startX = (await snapshot(pageA)).local.x;

  // Walk player A to the right for a fixed duration; movement is time-based
  // (held key sampled at 60Hz), so this wait is inherent to the scenario.
  await pageA.keyboard.down('ArrowRight');
  await pageA.waitForTimeout(WALK_MS);
  await pageA.keyboard.up('ArrowRight');

  // A's own prediction moved...
  expect((await snapshot(pageA)).local.x).toBeGreaterThan(startX + MIN_WALK_DISTANCE);

  // ...and B's interpolated view of A follows. (?? -Infinity: an offline
  // flicker empties the remote list; keep polling instead of throwing.)
  await expect
    .poll(async () => (await remoteX(pageB)) ?? Number.NEGATIVE_INFINITY, { timeout: 10_000 })
    .toBeGreaterThan(startX + MIN_WALK_DISTANCE);

  // Once A stands still, B's view converges on A's authoritative position.
  await expect
    .poll(
      async () => {
        const [a, bRemoteX] = await Promise.all([snapshot(pageA), remoteX(pageB)]);
        return Math.abs((bRemoteX ?? Number.POSITIVE_INFINITY) - a.local.x);
      },
      { timeout: 10_000 },
    )
    .toBeLessThan(1);

  await contextA.close();
  await contextB.close();
});
