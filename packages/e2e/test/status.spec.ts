// fallow-ignore-file coverage-gaps -- Playwright E2E spec; drives real browsers against a live SpacetimeDB host, outside unit coverage
import { expect, type Page, test } from '@playwright/test';
import { enterWorld, snapshot } from './helpers';

/** Clicks the availability button labelled `label` (the StatusControl row). */
async function setAvailability(page: Page, label: string): Promise<void> {
  await page.getByLabel(`ステータス ${label}`).click();
}

/** Fills the free-text status and submits (Enter, the chat-input way). Exact,
 * because the クリア button's label contains the input's label as a prefix. */
async function setStatusText(page: Page, text: string): Promise<void> {
  await page.getByLabel('ひとことステータス', { exact: true }).fill(text);
  await page.getByLabel('ひとことステータス', { exact: true }).press('Enter');
}

/**
 * The manual status end to end (ROADMAP Phase 2): switching to 取り込み中
 * shows the composed line under the sender's avatar on BOTH sides of the
 * wire (the sender's own display round-trips through the row event too),
 * the free-text line joins it, a reload keeps both (the seed half of the
 * display — a status is state, the opposite of the reaction's event-only
 * rule), and clearing both returns the default (no line) on both sides.
 * The line is canvas-drawn, so all assertions go through the __kaedeE2E
 * snapshot hook (the bubble/reaction precedent).
 *
 * The expected strings are the composed statusLabel output. Spelled out
 * rather than imported so the spec breaks if the label composition rule
 * changes silently — the label IS the user-visible contract here.
 *
 * The free text carries a nonce (the chat-spec rule): the world is shared
 * across specs and runs, and while a leftover status row from a previous
 * run belongs to a swept player (never rendered), a fixed string would
 * make the reload assertion prove less than it should.
 */
test('ステータスの3値切替と自由文が両画面に反映され、リロード後も保持され、クリアで消える', async ({
  browser,
}) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  await enterWorld(pageA);
  await enterWorld(pageB);

  // B must see A before the switch, so the assertions below measure status
  // propagation and not mere entry.
  await expect
    .poll(async () => (await snapshot(pageB)).remotePlayers.length, { timeout: 15_000 })
    .toBe(1);

  // 手動切替: the send round-trips through the server row before anything
  // renders — A's own line and B's view of it come from the same row event.
  await setAvailability(pageA, '取り込み中');
  const busy = '🔴 取り込み中';
  await expect
    .poll(async () => (await snapshot(pageA)).local.status, { timeout: 10_000 })
    .toBe(busy);
  await expect
    .poll(async () => (await snapshot(pageB)).remotePlayers[0]?.status, { timeout: 10_000 })
    .toBe(busy);

  // 自由文: joins the availability on the same line (the upsert row makes
  // this an UPDATE event, the other half of the display wiring).
  const note = `もくもく作業中・話しかけてOK ${Date.now() % 100_000}`;
  await setStatusText(pageA, note);
  const busyWithNote = `${busy}・${note}`;
  await expect
    .poll(async () => (await snapshot(pageA)).local.status, { timeout: 10_000 })
    .toBe(busyWithNote);
  await expect
    .poll(async () => (await snapshot(pageB)).remotePlayers[0]?.status, { timeout: 10_000 })
    .toBe(busyWithNote);

  // A status is STATE: a fresh navigation resumes the same identity and
  // restores both values from the initial subscription's seed — exactly
  // what a reaction must never do — and B keeps seeing them once A is
  // back. Polled on B's side too: the reload briefly flips A's row
  // offline, which hides A's remote view (and its status) until the
  // resume heartbeat lands.
  await enterWorld(pageA);
  await expect
    .poll(async () => (await snapshot(pageA)).local.status, { timeout: 10_000 })
    .toBe(busyWithNote);
  await expect
    .poll(async () => (await snapshot(pageB)).remotePlayers[0]?.status, { timeout: 10_000 })
    .toBe(busyWithNote);

  // Clearing both (the クリア button and the オンライン switch) returns the
  // default — no line — on both sides of the wire.
  await pageA.getByLabel('ひとことステータスをクリア').click();
  await setAvailability(pageA, 'オンライン');
  await expect
    .poll(async () => (await snapshot(pageA)).local.status, { timeout: 10_000 })
    .toBeUndefined();
  await expect
    .poll(async () => (await snapshot(pageB)).remotePlayers[0]?.status, { timeout: 10_000 })
    .toBeUndefined();

  await contextA.close();
  await contextB.close();
});
