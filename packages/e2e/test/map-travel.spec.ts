// fallow-ignore-file coverage-gaps -- Playwright E2E spec; drives real browsers against a live SpacetimeDB host, outside unit coverage
import { MAPS, MOVE_SPEED } from '@kaede/shared';
import { expect, type Page, test } from '@playwright/test';
import { enterWorld, localX, sendChat, snapshot, walkWhile } from './helpers';

const remoteCount = async (page: Page) => (await snapshot(page)).remotePlayers.length;
const remoteX = async (page: Page) => (await snapshot(page)).remotePlayers[0]?.x;
const mapId = async (page: Page) => (await snapshot(page)).mapId;

// The plaza→meeting-floor portal, straight from the shared map definition
// so the spec cannot drift from the world it tests.
const PORTAL_RECT = MAPS[0].portals[0].rect;

/**
 * Walks the player into the portal's trigger column and stops there. The
 * release overshoots by however long the keyup took to land, so this
 * corrects in (bounded) passes — walking back left when a slow CI runner
 * blew past the far edge.
 */
async function standInPortal(page: Page): Promise<void> {
  for (let i = 0; i < 5; i++) {
    const x = await localX(page);
    if (x >= PORTAL_RECT.x && x <= PORTAL_RECT.x + PORTAL_RECT.w) return;
    if (x < PORTAL_RECT.x) {
      await walkWhile(page, 'ArrowRight', (v) => v >= PORTAL_RECT.x);
    } else {
      await walkWhile(page, 'ArrowLeft', (v) => v <= PORTAL_RECT.x + PORTAL_RECT.w);
    }
  }
  throw new Error('could not stop inside the portal trigger');
}

/** One up-press (held across a few ticks so the 60Hz sampler cannot miss it). */
async function pressUp(page: Page): Promise<void> {
  await page.keyboard.down('ArrowUp');
  await page.waitForTimeout(150);
  await page.keyboard.up('ArrowUp');
}

// Two ~1,500px walks at MOVE_SPEED (240px/s) plus the sync polls: well over
// the config's 120s budget on a software-rendered CI runner.
test.setTimeout(300_000);

test('ポータルでマップを移動すると相手ブラウザに同期し、DM はマップを跨いで届く', async ({
  browser,
}) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  await enterWorld(pageA);
  await enterWorld(pageB);

  // Both spawn on the plaza (map 0) and see each other.
  expect(await mapId(pageA)).toBe(0);
  await expect.poll(() => remoteCount(pageA), { timeout: 15_000 }).toBe(1);
  await expect.poll(() => remoteCount(pageB), { timeout: 15_000 }).toBe(1);

  // B takes a resolvable name while both are still co-located, for the
  // cross-map DM below (the dm.spec nonce rule: names must not go
  // ambiguous across runs — player_name rows linger ~10 minutes).
  const nonce = Date.now().toString(36);
  const nameB = `B-${nonce}`;
  await pageB.getByLabel('表示名').fill(nameB);
  await pageB.getByRole('button', { name: '変更' }).click();
  await expect
    .poll(async () => (await snapshot(pageA)).remotePlayers.map((p) => p.name), {
      timeout: 10_000,
    })
    .toContain(nameB);

  // A walks to the portal (the deliberate 1,500px friction walk) and takes it.
  await standInPortal(pageA);
  await pressUp(pageA);
  await expect.poll(() => mapId(pageA), { timeout: 15_000 }).toBe(1);

  // The move syncs both ways: A's world no longer shows B (different map),
  // and B watches A vanish from the plaza.
  await expect.poll(() => remoteCount(pageA), { timeout: 15_000 }).toBe(0);
  await expect.poll(() => remoteCount(pageB), { timeout: 15_000 }).toBe(0);

  // A DM still reaches across maps: the mention resolves against the
  // space-wide presence directory (player_name), not the map-scoped
  // player subscription.
  const dmBody = `フロア越しでも届く ${nonce}`;
  await sendChat(pageA, `@${nameB} ${dmBody}`);
  await expect(pageB.getByRole('log')).toContainText(dmBody, { timeout: 10_000 });

  // B follows through the same portal; the two meet on the meeting floor.
  await standInPortal(pageB);
  await pressUp(pageB);
  await expect.poll(() => mapId(pageB), { timeout: 15_000 }).toBe(1);
  await expect.poll(() => remoteCount(pageA), { timeout: 15_000 }).toBe(1);
  await expect.poll(() => remoteCount(pageB), { timeout: 15_000 }).toBe(1);

  // Movement keeps syncing on the destination map (the movement-sync
  // assertion, replayed on map 1): B walks, A's interpolated view follows.
  const startX = await localX(pageB);
  const walkGoal = startX + MOVE_SPEED / 2;
  await walkWhile(pageB, 'ArrowRight', (x) => x > walkGoal);
  await expect
    .poll(async () => (await remoteX(pageA)) ?? Number.NEGATIVE_INFINITY, { timeout: 15_000 })
    .toBeGreaterThan(walkGoal);

  await contextA.close();
  await contextB.close();
});
