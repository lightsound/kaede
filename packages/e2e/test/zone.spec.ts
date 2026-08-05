// fallow-ignore-file coverage-gaps -- Playwright E2E spec; drives real browsers against a live SpacetimeDB host, outside unit coverage
import { ZONE_EXIT_MARGIN, zoneLabel, zoneTagLabel } from '@kaede/shared';
import { expect, type Page, test } from '@playwright/test';
import { enterWorld, snapshot, sql, walkWhile } from './helpers';

// The zone under test, seeded through owner SQL (the guest-admission
// precedent: creating one through the real create_zone reducer needs an
// approved admin member, and member identities require a Clerk sign-in,
// which stays out of E2E — the admin reducers' rules are unit-tested in
// @kaede/shared instead). What this spec fixes is the increment's core:
// the SERVER-side occupancy judgment on movement, and its sync to every
// client. The id is far above anything autoInc will assign, so the seeded
// row can never collide with a zone created through the reducer.
const ZONE_ID = 9001;
const ZONE_NAME = '会議室A';
// On the plaza (map 0), on the ground band right of spawn (x=200): the
// player's standing center (y=632) falls inside 464..656.
const ZONE_RECT = { x: 500, y: 464, w: 400, h: 192 };

async function seedZone(): Promise<void> {
  await sql(`DELETE FROM group_member WHERE group_id = ${ZONE_ID}`);
  await sql(`DELETE FROM conversation_group WHERE id = ${ZONE_ID}`);
  await sql(
    `INSERT INTO conversation_group (id, kind, name, closed, map_id, x, y, w, h) VALUES (${ZONE_ID}, 'zone', '${ZONE_NAME}', false, 0, ${ZONE_RECT.x}, ${ZONE_RECT.y}, ${ZONE_RECT.w}, ${ZONE_RECT.h})`,
  );
}

async function cleanupZone(): Promise<void> {
  await sql(`DELETE FROM group_member WHERE group_id = ${ZONE_ID}`);
  await sql(`DELETE FROM conversation_group WHERE id = ${ZONE_ID}`);
}

const localZone = async (page: Page) => (await snapshot(page)).local.zone;
const remoteZone = async (page: Page) => (await snapshot(page)).remotePlayers[0]?.zone;
const zoneList = async (page: Page) => (await snapshot(page)).zones;

// Two walks across the zone plus the sync polls: generous headroom for a
// software-rendered CI runner (the map-travel budget reasoning).
test.setTimeout(300_000);

/**
 * The meeting-room zone end to end (ROADMAP Phase 3 増分②): the zone
 * renders on every client, walking in flips the occupancy tag on BOTH
 * browsers (the server-side judgment riding accepted input batches),
 * walking out past the hysteresis margin clears it on both, and the
 * オープン/クローズド flag syncs into the rendering. Entry and exit are
 * ruled server-side, so what this spec observes on browser B is the whole
 * pipeline: A's inputs → replay → group_member write → B's subscription.
 */
test('ゾーンの入退室が相手ブラウザに同期し、クローズド表示も同期する', async ({ browser }) => {
  await seedZone();
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  try {
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    await enterWorld(pageA);
    await enterWorld(pageB);
    await expect.poll(() => remoteZone(pageB), { timeout: 15_000 }).toBeUndefined();

    // The seeded zone renders on both clients, open (no lock marker).
    const openLabel = zoneLabel(ZONE_NAME, false);
    await expect
      .poll(async () => (await zoneList(pageA)).map((zone) => zone.label), { timeout: 15_000 })
      .toContain(openLabel);
    await expect
      .poll(async () => (await zoneList(pageB)).map((zone) => zone.label), { timeout: 15_000 })
      .toContain(openLabel);

    // A walks into the zone; the occupancy tag appears on A's own avatar
    // AND on B's view of A — the server judged the entry and every client
    // heard it.
    const tag = zoneTagLabel(ZONE_NAME);
    await walkWhile(pageA, 'ArrowRight', (x) => x >= ZONE_RECT.x + 120);
    await expect.poll(() => localZone(pageA), { timeout: 15_000 }).toBe(tag);
    await expect.poll(() => remoteZone(pageB), { timeout: 15_000 }).toBe(tag);

    // A walks back out, past the exit hysteresis margin: the tag clears on
    // both browsers.
    const exitGoal = ZONE_RECT.x - ZONE_EXIT_MARGIN - 80;
    await walkWhile(pageA, 'ArrowLeft', (x) => x <= exitGoal);
    await expect.poll(() => localZone(pageA), { timeout: 15_000 }).toBeUndefined();
    await expect.poll(() => remoteZone(pageB), { timeout: 15_000 }).toBeUndefined();

    // The オープン/クローズド flag syncs into the rendering (the lock marker).
    await sql(`UPDATE conversation_group SET closed = true WHERE id = ${ZONE_ID}`);
    const closedLabel = zoneLabel(ZONE_NAME, true);
    await expect
      .poll(async () => (await zoneList(pageA)).map((zone) => zone.label), { timeout: 15_000 })
      .toContain(closedLabel);
    expect((await zoneList(pageA)).find((zone) => zone.label === closedLabel)?.closed).toBe(true);
  } finally {
    await contextA.close();
    await contextB.close();
    await cleanupZone();
  }
});
