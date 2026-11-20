// fallow-ignore-file coverage-gaps -- Playwright E2E spec; drives real browsers against a live SpacetimeDB host, outside unit coverage
import { expect, test } from '@playwright/test';
import { enterWorld, snapshot } from './helpers';

const NEW_NAME = 'かえで';

test('表示名を変更すると両ブラウザに反映され、リロード後も保持される', async ({ browser }) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  await enterWorld(pageA);
  await enterWorld(pageB);

  await expect
    .poll(async () => (await snapshot(pageB)).remotePlayers.length, { timeout: 15_000 })
    .toBe(1);

  await pageA.getByLabel('表示名').fill(NEW_NAME);
  await pageA.getByRole('button', { name: '変更' }).click();

  await expect
    .poll(async () => (await snapshot(pageA)).local.name, { timeout: 10_000 })
    .toBe(NEW_NAME);
  await expect
    .poll(async () => (await snapshot(pageB)).remotePlayers[0]?.name, { timeout: 10_000 })
    .toBe(NEW_NAME);

  await enterWorld(pageA);
  expect((await snapshot(pageA)).local.name).toBe(NEW_NAME);

  await contextA.close();
  await contextB.close();
});
