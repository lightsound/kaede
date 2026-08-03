// fallow-ignore-file coverage-gaps -- Playwright E2E spec; drives real browsers against a live SpacetimeDB host, outside unit coverage
import { expect, type Page, test } from '@playwright/test';
import { enterWorld, snapshot } from './helpers';

/** Fills the chat input and submits (Enter — the chat.spec way). */
async function sendChat(page: Page, text: string): Promise<void> {
  await page.getByLabel('チャット入力').fill(text);
  await page.getByLabel('チャット入力').press('Enter');
}

/**
 * How many dm_message rows this client's subscription has been handed
 * (seed + insert events), via the dev-only net-stats hook. THE privacy
 * probe: a DM line missing from a third party's DOM would also be true of
 * a display-layer filter over leaked rows, so the spec asserts on what
 * actually crossed the wire.
 */
function dmRowsReceived(page: Page): Promise<number> {
  return page.evaluate(() => {
    const stats = window.__mapleE2ENet;
    if (!stats) throw new Error('__mapleE2ENet hook is not installed');
    return stats.dmRowsReceived;
  });
}

/**
 * The @mention DM end to end (ROADMAP Phase 2), across three browsers:
 * sender A, recipient B, third party C.
 *
 * - B renames first (the display-name flow): guests spawn as
 *   Player-xxxxxx, and the mention must resolve a human-typed name. The
 *   name carries a nonce (the chat.spec rule): the world is shared across
 *   specs and runs, player_name rows linger ~10 minutes after leaving,
 *   and a fixed name would go ambiguous on re-runs — which the resolver
 *   refuses by design. Base-36 keeps it inside DISPLAY_NAME_MAX_LENGTH.
 * - Privacy is asserted the strong way: after B provably received the DM
 *   (so "not yet" cannot masquerade as "never"), C's client must have
 *   received ZERO dm_message rows — live, and again after a reload (the
 *   subscription seed side, where row-level security must filter too).
 * - A resolution failure (mentioning a name nobody holds) must show a
 *   send error and never fall back to the public chat.
 * - Reloading A and B shows the retention policy: DM history survives in
 *   both participants' logs (unlike bubbles/reactions, seeded on entry).
 */
test('DM が宛先にだけ届き、第三者にはリロード後も行が届かず、解決失敗は公開に流れない', async ({
  browser,
}) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const contextC = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  const pageC = await contextC.newPage();

  await enterWorld(pageA);
  await enterWorld(pageB);
  await enterWorld(pageC);

  // A must see both B and C before renaming/mentioning, so resolution
  // rules on a fully-propagated room.
  await expect
    .poll(async () => (await snapshot(pageA)).remotePlayers.length, { timeout: 15_000 })
    .toBe(2);

  const nonce = Date.now().toString(36);
  const nameB = `B-${nonce}`;
  await pageB.getByLabel('表示名').fill(nameB);
  await pageB.getByRole('button', { name: '変更' }).click();

  // The rename round-trips through the server before A can resolve it.
  await expect
    .poll(async () => (await snapshot(pageA)).remotePlayers.map((p) => p.name), {
      timeout: 10_000,
    })
    .toContain(nameB);

  // A → B. The DM must reach B's log (and A's own), never C.
  const dmBody = `ひみつの話 ${nonce}`;
  await sendChat(pageA, `@${nameB} ${dmBody}`);
  await expect(pageB.getByRole('log')).toContainText(dmBody, { timeout: 10_000 });
  await expect(pageB.getByRole('log')).toContainText(`→ ${nameB}`);
  await expect(pageA.getByRole('log')).toContainText(dmBody, { timeout: 10_000 });

  // No speech bubble for a DM — a bubble is public speech. Checked on B
  // right after the row event that would have shown one.
  expect((await snapshot(pageB)).remotePlayers.every((p) => p.bubble === undefined)).toBe(true);

  // The strong negative, timed AFTER B's receipt: C's client was handed no
  // dm_message row at all.
  expect(await dmRowsReceived(pageC)).toBe(0);
  await expect(pageC.getByRole('log')).not.toContainText(dmBody);
  // Positive control for the probe itself: both participants counted rows.
  expect(await dmRowsReceived(pageB)).toBeGreaterThan(0);
  expect(await dmRowsReceived(pageA)).toBeGreaterThan(0);

  // A resolution failure shows a send error and must not leak anywhere.
  const leakBody = `もれてはいけない ${nonce}`;
  await sendChat(pageA, `@Nobody-${nonce} ${leakBody}`);
  await expect(pageA.getByText('宛先が見つかりません', { exact: false })).toBeVisible();

  // A public line after the failed attempt gives every later negative
  // check a delivery marker to wait on (ordering beats sleeping).
  const publicBody = `みんなへ ${nonce}`;
  await sendChat(pageA, publicBody);
  await expect(pageB.getByRole('log')).toContainText(publicBody, { timeout: 10_000 });
  await expect(pageC.getByRole('log')).toContainText(publicBody, { timeout: 10_000 });
  await expect(pageA.getByRole('log')).not.toContainText(leakBody);
  await expect(pageC.getByRole('log')).not.toContainText(leakBody);

  // Seed-side privacy: a reloaded C re-subscribes from scratch; once the
  // public history proves the seed applied, its DM row count must still
  // be zero.
  await enterWorld(pageC);
  await expect(pageC.getByRole('log')).toContainText(publicBody, { timeout: 10_000 });
  expect(await dmRowsReceived(pageC)).toBe(0);
  await expect(pageC.getByRole('log')).not.toContainText(dmBody);

  // Retention: both participants reload and the DM history comes back
  // through the seed (row-level security hands each its own rows).
  await enterWorld(pageA);
  await expect(pageA.getByRole('log')).toContainText(dmBody, { timeout: 10_000 });
  await enterWorld(pageB);
  await expect(pageB.getByRole('log')).toContainText(dmBody, { timeout: 10_000 });
  expect(await dmRowsReceived(pageB)).toBeGreaterThan(0);

  await contextA.close();
  await contextB.close();
  await contextC.close();
});
