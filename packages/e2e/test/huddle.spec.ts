// fallow-ignore-file coverage-gaps -- Playwright E2E spec; drives real browsers against a live SpacetimeDB host, outside unit coverage
import {
  HUDDLE_DEFAULT_NAME,
  HUDDLE_LEAVE_DISTANCE,
  huddleLabel,
  zoneTagLabel,
} from '@kaede/shared';
import { expect, type Page, test } from '@playwright/test';
import { enterWorld, localX, snapshot, sql, walkWhile } from './helpers';

// What this file fixes is the increment's core (ROADMAP Phase 3 増分③):
// anyone founds a huddle on the spot through the real reducers (guests
// qualify, so unlike the zone spec nothing needs SQL seeding), joining is
// a proximity-gated explicit act, the walk-away auto-leave is judged
// SERVER-side on the authoritative rows, an emptied huddle's row is
// cleaned up, and all of it syncs to the other browser.

const openLabel = huddleLabel(HUDDLE_DEFAULT_NAME, false);

const localZone = async (page: Page) => (await snapshot(page)).local.zone;
const remoteZone = async (page: Page) => (await snapshot(page)).remotePlayers[0]?.zone;
const huddleList = async (page: Page) => (await snapshot(page)).huddles;
const huddleMembers = async (page: Page, label: string) =>
  (await huddleList(page)).find((huddle) => huddle.label === label)?.members;

// Walks plus cross-browser sync polls: the map-travel/zone budget reasoning
// for a software-rendered CI runner.
test.setTimeout(300_000);

/**
 * The huddle lifecycle end to end: A founds one where it stands (both
 * tags and the circle appear on BOTH browsers), B walks up and joins
 * through the proximity-gated button, B walks away past
 * HUDDLE_LEAVE_DISTANCE and the SERVER removes it (no leave call), the
 * circle follows A (solo) walking, and A's explicit leave empties the
 * huddle and cleans the group row up everywhere.
 */
test('立ち話の発足・参加・歩き去り自動離脱・解散が相手ブラウザに同期する', async ({ browser }) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  try {
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    await enterWorld(pageA);
    await enterWorld(pageB);
    await expect.poll(() => remoteZone(pageB), { timeout: 15_000 }).toBeUndefined();

    // A founds a huddle on the spot (the default name — one click).
    await pageA.getByRole('button', { name: 'ここで立ち話' }).click();
    await expect.poll(() => localZone(pageA), { timeout: 15_000 }).toBe(openLabel);
    await expect.poll(() => remoteZone(pageB), { timeout: 15_000 }).toBe(openLabel);
    await expect.poll(() => huddleMembers(pageB, openLabel), { timeout: 15_000 }).toBe(1);

    // B spawned next to A, so the proximity-gated join button offers this
    // huddle; joining flips B's tag on both browsers and the circle counts
    // two member sprites.
    await pageB.getByRole('button', { name: `${openLabel} に参加` }).click({ timeout: 15_000 });
    await expect.poll(() => localZone(pageB), { timeout: 15_000 }).toBe(openLabel);
    await expect.poll(() => huddleMembers(pageA, openLabel), { timeout: 15_000 }).toBe(2);

    // B walks away past the leave distance: the server-side retention rule
    // (riding B's own accepted batches) removes B with no leave call, on
    // both browsers; A stays, now solo.
    const start = await localX(pageB);
    await walkWhile(pageB, 'ArrowRight', (x) => x >= start + HUDDLE_LEAVE_DISTANCE + 100);
    await expect.poll(() => localZone(pageB), { timeout: 15_000 }).toBeUndefined();
    await expect.poll(() => huddleMembers(pageA, openLabel), { timeout: 15_000 }).toBe(1);
    await expect.poll(() => localZone(pageA), { timeout: 15_000 }).toBe(openLabel);

    // The solo huddle follows its founder's avatar: A walks and the circle
    // keeps rendering around A (members 1, tag intact) instead of leaving.
    const startA = await localX(pageA);
    await walkWhile(pageA, 'ArrowRight', (x) => x >= startA + 200);
    await expect.poll(() => localZone(pageA), { timeout: 15_000 }).toBe(openLabel);
    await expect.poll(() => huddleMembers(pageB, openLabel), { timeout: 15_000 }).toBe(1);

    // A leaves explicitly: the huddle hits zero members and its row is
    // cleaned up — the circle disappears from both browsers.
    await pageA.getByRole('button', { name: '抜ける' }).click();
    await expect.poll(() => localZone(pageA), { timeout: 15_000 }).toBeUndefined();
    await expect.poll(async () => (await huddleList(pageB)).length, { timeout: 15_000 }).toBe(0);
  } finally {
    await contextA.close();
    await contextB.close();
  }
});

/**
 * The クローズド rendering (「コソコソ話している」): a named, closed huddle
 * renders with the 🤫 label — on the circle and on the member's tag — for
 * the other browser too. The chat invisibility itself is 増分④'s RLS.
 */
test('クローズドの立ち話は 🤫 のコソコソ表示で相手ブラウザにも同期する', async ({ browser }) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  try {
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    await enterWorld(pageA);
    await enterWorld(pageB);

    const closedLabel = huddleLabel('内緒', true);
    await pageA.getByLabel('立ち話の名前').fill('内緒');
    await pageA.getByLabel('コソコソ話す').check();
    await pageA.getByRole('button', { name: 'ここで立ち話' }).click();

    await expect.poll(() => localZone(pageA), { timeout: 15_000 }).toBe(closedLabel);
    await expect.poll(() => remoteZone(pageB), { timeout: 15_000 }).toBe(closedLabel);
    await expect
      .poll(
        async () =>
          (await huddleList(pageB)).find((huddle) => huddle.label === closedLabel)?.closed,
        { timeout: 15_000 },
      )
      .toBe(true);

    await pageA.getByRole('button', { name: '抜ける' }).click();
    await expect.poll(async () => (await huddleList(pageB)).length, { timeout: 15_000 }).toBe(0);
  } finally {
    await contextA.close();
    await contextB.close();
  }
});

// The zone under the interplay test, seeded through owner SQL (the zone
// spec's precedent — placing one through create_zone needs an admin, which
// needs a Clerk sign-in that stays out of E2E). Covers spawn (x=200,
// standing center y=632 inside 464..656). The id sits far above anything
// autoInc will assign.
const ZONE_ID = 9101;
const ZONE_NAME = '会議室H';

/**
 * The zone↔huddle interplay decision, end to end: founding a huddle while
 * standing INSIDE a meeting-room zone moves the membership to the huddle
 * (explicit intent outranks standing geometry), and leaving the huddle
 * puts the still-inside player back into the zone in the same reducer
 * call — no movement needed.
 */
test('ゾーン在室中の立ち話発足はゾーンに優先し、解散後はゾーンへ戻る', async ({ browser }) => {
  await sql(`DELETE FROM group_member WHERE group_id = ${ZONE_ID}`);
  await sql(`DELETE FROM conversation_group WHERE id = ${ZONE_ID}`);
  await sql(
    `INSERT INTO conversation_group (id, kind, name, closed, map_id, x, y, w, h) VALUES (${ZONE_ID}, 'zone', '${ZONE_NAME}', false, 0, 40, 464, 400, 192)`,
  );
  const contextA = await browser.newContext();
  try {
    const pageA = await contextA.newPage();
    await enterWorld(pageA);
    const zoneTag = zoneTagLabel(ZONE_NAME);
    await expect.poll(() => localZone(pageA), { timeout: 15_000 }).toBe(zoneTag);

    await pageA.getByRole('button', { name: 'ここで立ち話' }).click();
    await expect.poll(() => localZone(pageA), { timeout: 15_000 }).toBe(openLabel);

    await pageA.getByRole('button', { name: '抜ける' }).click();
    await expect.poll(() => localZone(pageA), { timeout: 15_000 }).toBe(zoneTag);
  } finally {
    await contextA.close();
    await sql(`DELETE FROM group_member WHERE group_id = ${ZONE_ID}`);
    await sql(`DELETE FROM conversation_group WHERE id = ${ZONE_ID}`);
  }
});
