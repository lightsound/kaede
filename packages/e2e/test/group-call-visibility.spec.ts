// fallow-ignore-file coverage-gaps -- Playwright E2E spec; drives real browsers against a live SpacetimeDB host, outside unit coverage
import { ZONE_EXIT_MARGIN, zoneTagLabel } from '@kaede/shared';
import { expect, type Page, test } from '@playwright/test';
import { enterWorld, netStats, snapshot, sql, walkWhile } from './helpers';

// What this file fixes is 増分①'s privacy core: a group_call row's meeting
// id is the JOIN CAPABILITY for the group's call (the token Worker checks
// a kaede identity, not group membership — SpacetimeDB is the only group
// authority), so the row must reach group MEMBERS only. Asserted on
// what crossed the wire (groupCallRowsReceived), not on the DOM — the
// chat-scope spec's reasoning: a display filter could hide a delivered row.
//
// The row is seeded through owner SQL rather than the register_group_call
// reducer: registering through the UI needs the call Worker and a Clerk
// member (out of E2E — the zone.spec precedent), and what this spec fixes
// is the RLS delivery, not the reducer's vetting (unit-tested rules +
// non-owner refusals are the reducer's own coverage).

const ZONE_ID = 9101;
const ZONE_NAME = '通話室';
// On the plaza (map 0), on the ground band right of spawn (the zone.spec
// placement reasoning): the player's standing center falls inside.
const ZONE_RECT = { x: 500, y: 464, w: 400, h: 192 };
const MEETING_ID = 'bbb8280d-7d30-430b-a3a0-78802ed5617c';

async function seedZone(): Promise<void> {
  await sql(`DELETE FROM group_call WHERE group_id = ${ZONE_ID}`);
  await sql(`DELETE FROM group_member WHERE group_id = ${ZONE_ID}`);
  await sql(`DELETE FROM conversation_group WHERE id = ${ZONE_ID}`);
  await sql(
    `INSERT INTO conversation_group (id, kind, name, closed, map_id, x, y, w, h) VALUES (${ZONE_ID}, 'zone', '${ZONE_NAME}', false, 0, ${ZONE_RECT.x}, ${ZONE_RECT.y}, ${ZONE_RECT.w}, ${ZONE_RECT.h})`,
  );
}

async function cleanup(): Promise<void> {
  await sql(`DELETE FROM group_call WHERE group_id = ${ZONE_ID}`);
  await sql(`DELETE FROM group_member WHERE group_id = ${ZONE_ID}`);
  await sql(`DELETE FROM conversation_group WHERE id = ${ZONE_ID}`);
}

const localZone = async (page: Page) => (await snapshot(page)).local.zone;
const callRows = async (page: Page) => (await netStats(page)).groupCallRowsReceived;

// Two walks across the zone plus the sync polls: generous headroom for a
// software-rendered CI runner (the zone.spec budget reasoning).
test.setTimeout(300_000);

/**
 * The call registry's row-level security end to end: A stands in the zone
 * (a member), B stands outside (a non-member). The seeded group_call row
 * reaches A's subscription; B is handed ZERO rows — live, and through the
 * seed after a reload. B then walks in: membership is what the filter
 * reads, so the row arrives (the positive control proving the probe can
 * see rows at all). Guests get the call dock like members (増分② — the
 * Worker verifies their host-issued token), which the button's presence
 * pins; joining stays a manual test (the Worker is out of E2E).
 */
test('通話レジストリの行はグループのメンバーだけに届き、ゲストにも通話ボタンが出る', async ({
  browser,
}) => {
  await seedZone();
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  try {
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    await enterWorld(pageA);
    await enterWorld(pageB);

    // A walks into the zone and becomes its member; B stays put at spawn.
    const tag = zoneTagLabel(ZONE_NAME);
    await walkWhile(pageA, 'ArrowRight', (x) => x >= ZONE_RECT.x + 120);
    await expect.poll(() => localZone(pageA), { timeout: 15_000 }).toBe(tag);
    expect(await callRows(pageA)).toBe(0);
    expect(await callRows(pageB)).toBe(0);

    // The call registry row lands: the member's subscription is handed it…
    await sql(`INSERT INTO group_call (group_id, meeting_id) VALUES (${ZONE_ID}, '${MEETING_ID}')`);
    await expect.poll(() => callRows(pageA), { timeout: 15_000 }).toBeGreaterThan(0);
    // …and the non-member's is not. Timed AFTER A provably received it, so
    // "not yet" cannot masquerade as "never".
    expect(await callRows(pageB)).toBe(0);

    // A is a GUEST in a group: the dock offers the call (増分② lifted the
    // members-only cut — guests start, join and screen-share like members;
    // the actual join needs the live Worker, out of E2E). B, outside every
    // group, is offered nothing.
    await expect(pageA.getByRole('button', { name: '📞 通話に参加' })).toBeVisible();
    await expect(pageB.getByRole('button', { name: '📞 通話に参加' })).toHaveCount(0);

    // Seed-side privacy: a reloaded B re-subscribes from scratch and its
    // count is still zero (world entry proves the seed applied — the
    // subscription lands before the spawn).
    await enterWorld(pageB);
    expect(await callRows(pageB)).toBe(0);

    // The positive control: B walks in, the server grants the membership,
    // and row-level security hands B the capability row it was hiding.
    await walkWhile(pageB, 'ArrowRight', (x) => x >= ZONE_RECT.x + 120);
    await expect.poll(() => localZone(pageB), { timeout: 15_000 }).toBe(tag);
    await expect.poll(() => callRows(pageB), { timeout: 15_000 }).toBeGreaterThan(0);

    // And the revocation round-trip: B walks back out past the hysteresis
    // margin; the membership drops server-side. The row leaves B's CACHE
    // as a delete (増分④の実測), which the counter (a receipts counter, by
    // design) cannot see — so the exit is asserted on the occupancy tag,
    // and the cache-side revocation stays chat-scope.spec's assertion.
    await walkWhile(pageB, 'ArrowLeft', (x) => x <= ZONE_RECT.x - ZONE_EXIT_MARGIN - 80);
    await expect.poll(() => localZone(pageB), { timeout: 15_000 }).toBeUndefined();
  } finally {
    await contextA.close();
    await contextB.close();
    await cleanup();
  }
});
