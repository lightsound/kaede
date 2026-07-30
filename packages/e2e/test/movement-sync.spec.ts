// fallow-ignore-file coverage-gaps -- Playwright E2E spec; drives real browsers against a live SpacetimeDB host, outside unit coverage
import { MOVE_SPEED } from '@maple/shared';
import { expect, type Page, test } from '@playwright/test';
import { enterWorld, snapshot } from './helpers';

const remoteCount = async (page: Page) => (await snapshot(page)).remotePlayers.length;
/** The single remote player's x, or undefined during a transient empty list. */
const remoteX = async (page: Page) => (await snapshot(page)).remotePlayers[0]?.x;

// Walk far enough that sync is unmistakable: half a second of walking on the
// flat ground around the spawn. The key is held until the position actually
// passes this mark (not for a fixed duration), so a low-FPS CI renderer —
// where MAX_FRAME caps how much simulation each frame may advance — only
// makes the walk take longer, never fail.
const MIN_WALK_DISTANCE = MOVE_SPEED / 2;

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

  // Walk player A to the right until its own prediction has covered the
  // distance (this poll is itself the "A moved" assertion).
  await pageA.keyboard.down('ArrowRight');
  await expect
    .poll(async () => (await snapshot(pageA)).local.x, { timeout: 15_000 })
    .toBeGreaterThan(startX + MIN_WALK_DISTANCE);
  await pageA.keyboard.up('ArrowRight');

  // B's interpolated view of A follows. (?? -Infinity: an offline flicker
  // empties the remote list; keep polling instead of throwing.)
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
