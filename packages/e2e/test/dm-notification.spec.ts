// fallow-ignore-file coverage-gaps -- Playwright E2E spec; drives real browsers against a live SpacetimeDB host, outside unit coverage
import { expect, type Page, test } from '@playwright/test';
import { enterWorld, snapshot } from './helpers';

/** Fills the chat input and submits (Enter — the chat.spec way). */
async function sendChat(page: Page, text: string): Promise<void> {
  await page.getByLabel('チャット入力').fill(text);
  await page.getByLabel('チャット入力').press('Enter');
}

/**
 * How many DM rows this client DECIDED to notify for, via the dev-only
 * net-stats hook. An OS notification is unobservable from a test, so the
 * spec asserts on the decision count — which the client bumps before (and
 * regardless of) Notification construction, so it measures the unit-tested
 * rule applied to live inputs, not the platform's willingness to display.
 */
function dmNotifyDecisions(page: Page): Promise<number> {
  return page.evaluate(() => {
    const stats = window.__mapleE2ENet;
    if (!stats) throw new Error('__mapleE2ENet hook is not installed');
    return stats.dmNotifyDecisions;
  });
}

/** The privacy probe from dm.spec.ts: rows actually handed to this client. */
function dmRowsReceived(page: Page): Promise<number> {
  return page.evaluate(() => {
    const stats = window.__mapleE2ENet;
    if (!stats) throw new Error('__mapleE2ENet hook is not installed');
    return stats.dmRowsReceived;
  });
}

/**
 * The DM browser notification end to end (ROADMAP Phase 2), across three
 * browsers: sender A (no notification permission — everything must keep
 * working there), recipient B (permission granted), third party C
 * (granted AND backgrounded, so the ONLY thing keeping its count at zero
 * is that no row reaches it — the RLS regression guard).
 *
 * Backgrounding is the dev-only `?visibility=hidden` override, not a real
 * background tab: measured on this Playwright/Chromium combination
 * (2026-08-03), two pages in one headless context both report
 * `document.visibilityState === 'visible'` and `document.hasFocus() ===
 * true` no matter which was last brought to front — in BOTH headless
 * builds (the default headless shell and channel:'chromium' below) — so a
 * real tab switch is not reproducible headlessly. The override replaces
 * only the ENVIRONMENT INPUTS of the decision; the decision rule itself
 * (shouldNotifyDm — seed/own/visible/permission) is fixed by unit tests
 * in @maple/shared.
 */

// Full Chromium instead of the default headless shell, for this file only:
// measured 2026-08-03, the headless shell keeps `Notification.permission`
// at 'denied' even after grantPermissions (while permissions.query says
// 'granted' — the API the client actually reads is the broken one), which
// would refuse every notification for the wrong reason. Full Chromium's
// headless honors the grant. CI installs it already (`playwright install
// chromium` ships both builds since Playwright 1.49).
test.use({ channel: 'chromium' });
test('バックグラウンドの B への DM だけが通知判定になり、可視タブ・自分の送信・seed・第三者では増えない', async ({
  browser,
}) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const contextC = await browser.newContext();
  await contextB.grantPermissions(['notifications'], { origin: 'http://localhost:5173' });
  await contextC.grantPermissions(['notifications'], { origin: 'http://localhost:5173' });
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  const pageC = await contextC.newPage();

  await enterWorld(pageA);
  await enterWorld(pageB);
  await enterWorld(pageC, '/?visibility=hidden');

  // Sanity for the permission lever itself, so a later zero can only mean
  // "the rule refused", never "the grant silently failed".
  expect(
    await pageB.evaluate(() =>
      typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
    ),
  ).toBe('granted');

  // A must see both B and C before renaming/mentioning (the dm.spec rule).
  await expect
    .poll(async () => (await snapshot(pageA)).remotePlayers.length, { timeout: 15_000 })
    .toBe(2);

  const nonce = Date.now().toString(36);
  const nameB = `B-${nonce}`;
  await pageB.getByLabel('表示名').fill(nameB);
  await pageB.getByRole('button', { name: '変更' }).click();
  await expect
    .poll(async () => (await snapshot(pageA)).remotePlayers.map((p) => p.name), {
      timeout: 10_000,
    })
    .toContain(nameB);

  // (1) A visible, permission-granted B receives a DM: delivered to the
  // log, but never a notification — the tab is visible (un-hidden and
  // focused, the headless default).
  const dmVisible = `見えてるとき ${nonce}`;
  await sendChat(pageA, `@${nameB} ${dmVisible}`);
  await expect(pageB.getByRole('log')).toContainText(dmVisible, { timeout: 10_000 });
  expect(await dmNotifyDecisions(pageB)).toBe(0);

  // (2) B backgrounds (reload with the visibility override): the seed
  // hands the DM history back — the log restores, the notify count must
  // NOT move (通知は行イベントのみ、seed からは絶対に出さない).
  await enterWorld(pageB, '/?visibility=hidden');
  await expect(pageB.getByRole('log')).toContainText(dmVisible, { timeout: 10_000 });
  expect(await dmRowsReceived(pageB)).toBeGreaterThan(0);
  expect(await dmNotifyDecisions(pageB)).toBe(0);

  // (3) A DMs the backgrounded B: THE notification case.
  const dmHidden = `背景あての通知 ${nonce}`;
  await sendChat(pageA, `@${nameB} ${dmHidden}`);
  await expect(pageB.getByRole('log')).toContainText(dmHidden, { timeout: 10_000 });
  await expect.poll(() => dmNotifyDecisions(pageB), { timeout: 5_000 }).toBe(1);

  // (4) B's own send (a self-DM memo) lands as a row event on B while
  // hidden and granted — own must be the clause that refuses it.
  const memo = `自分メモ ${nonce}`;
  await sendChat(pageB, `@${nameB} ${memo}`);
  await expect(pageB.getByRole('log')).toContainText(memo, { timeout: 10_000 });
  expect(await dmNotifyDecisions(pageB)).toBe(1);

  // (5) Scope is DM-only: a public message reaching the backgrounded B
  // must not notify.
  const publicBody = `みんなへ ${nonce}`;
  await sendChat(pageA, publicBody);
  await expect(pageB.getByRole('log')).toContainText(publicBody, { timeout: 10_000 });
  expect(await dmNotifyDecisions(pageB)).toBe(1);

  // (6) The third party C — granted and backgrounded, so only row-level
  // security keeps this at zero: no dm_message row, no decision.
  await expect(pageC.getByRole('log')).toContainText(publicBody, { timeout: 10_000 });
  expect(await dmRowsReceived(pageC)).toBe(0);
  expect(await dmNotifyDecisions(pageC)).toBe(0);

  // A never notified either: visible, and its context has no permission —
  // and nothing about A's session (sending, receiving echoes) broke.
  expect(await dmNotifyDecisions(pageA)).toBe(0);
  await expect(pageA.getByRole('log')).toContainText(dmHidden);

  await contextA.close();
  await contextB.close();
  await contextC.close();
});
