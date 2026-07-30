// fallow-ignore-file coverage-gaps -- Playwright E2E spec; drives real browsers against a live SpacetimeDB host, outside unit coverage
import { expect, test } from '@playwright/test';
import { enterWorld, snapshot } from './helpers';

const NEW_NAME = 'かえで';

/**
 * The display-name flow end to end (ROADMAP Phase 1: プロフィールの永続化):
 * renaming through the form updates the sender's own label, propagates to
 * the other browser, and survives a reload — a reloaded tab resumes its
 * identity (guests via sessionStorage), so the server hands back the row
 * carrying the name. Member persistence across devices rides the same
 * set_display_name/join path with the account table behind it; Clerk sign-in
 * itself stays out of E2E until the login replacement lands (ROADMAP).
 */
test('表示名を変更すると両ブラウザに反映され、リロード後も保持される', async ({ browser }) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  await enterWorld(pageA);
  await enterWorld(pageB);

  // B must be able to see A before the rename, so the later name assertion
  // measures propagation and not mere entry.
  await expect
    .poll(async () => (await snapshot(pageB)).remotePlayers.length, { timeout: 15_000 })
    .toBe(1);
  const defaultName = (await snapshot(pageA)).local.name;

  await pageA.getByLabel('表示名').fill(NEW_NAME);
  await pageA.getByRole('button', { name: '変更' }).click();

  // The rename round-trips through the server row before the label changes.
  await expect
    .poll(async () => (await snapshot(pageA)).local.name, { timeout: 10_000 })
    .toBe(NEW_NAME);
  // (?? previous name: an offline flicker empties the remote list; keep
  // polling instead of failing on a transient undefined.)
  await expect
    .poll(async () => (await snapshot(pageB)).remotePlayers[0]?.name ?? defaultName, {
      timeout: 10_000,
    })
    .toBe(NEW_NAME);

  // A fresh navigation resumes the same identity (sessionStorage token), so
  // the server hands back the row still carrying the name.
  await enterWorld(pageA);
  expect((await snapshot(pageA)).local.name).toBe(NEW_NAME);

  await contextA.close();
  await contextB.close();
});
