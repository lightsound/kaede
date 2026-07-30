// fallow-ignore-file coverage-gaps -- Playwright E2E spec; drives real browsers against a live SpacetimeDB host, outside unit coverage
import { expect, type Page, test } from '@playwright/test';

/** The subset of the client's `__mapleE2E` snapshot that this spec reads. */
interface WorldSnapshot {
  local: { x: number };
  remotePlayers: { x: number }[];
}

type HookWindow = Window & { __mapleE2E?: { snapshot(): WorldSnapshot } };

function snapshot(page: Page): Promise<WorldSnapshot> {
  return page.evaluate(() => {
    const hook = (window as HookWindow).__mapleE2E;
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
  await page.waitForFunction(() => (window as HookWindow).__mapleE2E !== undefined);
}

const remoteCount = async (page: Page) => (await snapshot(page)).remotePlayers.length;

// Walking speed is 240px/s (MOVE_SPEED) on flat ground around the spawn, so
// one second of held ArrowRight moves ~240px; 100px keeps the assertion far
// from both "did not move" and any timing jitter.
const WALK_MS = 1000;
const MIN_WALK_DISTANCE = 100;

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

  const startX = (await snapshot(pageB)).remotePlayers[0].x;

  // Walk player A to the right for a fixed duration; movement is time-based
  // (held key sampled at 60Hz), so this wait is inherent to the scenario.
  await pageA.keyboard.down('ArrowRight');
  await pageA.waitForTimeout(WALK_MS);
  await pageA.keyboard.up('ArrowRight');

  // A's own prediction moved...
  expect((await snapshot(pageA)).local.x).toBeGreaterThan(startX + MIN_WALK_DISTANCE);

  // ...and B's interpolated view of A follows.
  await expect
    .poll(async () => (await snapshot(pageB)).remotePlayers[0].x, { timeout: 10_000 })
    .toBeGreaterThan(startX + MIN_WALK_DISTANCE);

  // Once A stands still, B's view converges on A's authoritative position.
  await expect
    .poll(
      async () => {
        const [a, b] = await Promise.all([snapshot(pageA), snapshot(pageB)]);
        return Math.abs(b.remotePlayers[0].x - a.local.x);
      },
      { timeout: 10_000 },
    )
    .toBeLessThan(1);

  await contextA.close();
  await contextB.close();
});
