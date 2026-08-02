// fallow-ignore-file coverage-gaps -- Playwright E2E spec; drives real browsers against a live SpacetimeDB host, outside unit coverage
import { expect, type Page, test } from '@playwright/test';
import { enterWorld, snapshot } from './helpers';

const remoteCount = async (page: Page) => (await snapshot(page)).remotePlayers.length;

// 本番の 15 分を待たず休止を起こすための開発ビルド限定の上書き(idle.ts)。
// 入場処理(接続→join→自スポーン行の往復)より十分長く、テストが遅すぎない値。
const IDLE_MS = 3000;

test('無操作のクライアントは接続を休止して退出し、操作すると自動で再入場する', async ({
  browser,
}) => {
  // 2 コンテキスト = sessionStorage が別の 2 タブなので、サーバーからは
  // 別々のゲスト Identity に見える。B が観測者、A が放置されるタブ。
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  // 観測者を先に入れておく。A のアイドル時計は A の入場時に走り始めるため、
  // この順なら「互いに見える」の検証が A の休止と競走しない。
  await enterWorld(pageB);
  await enterWorld(pageA, `/?idleMs=${IDLE_MS}`);

  // 入場は相互に見える(以降の退出・再入場の基準)。
  await expect.poll(() => remoteCount(pageA), { timeout: 15_000 }).toBe(1);
  await expect.poll(() => remoteCount(pageB), { timeout: 15_000 }).toBe(1);

  // A を無操作のまま放置すると、A は自分から接続を休止し(バナーで告知)、
  // B からは退出して見える(サーバーが行を offline にし、offline 行は
  // 描画されない)。
  await expect(pageA.getByText('接続を休止しています')).toBeVisible({
    timeout: IDLE_MS + 10_000,
  });
  await expect.poll(() => remoteCount(pageB), { timeout: 10_000 }).toBe(0);

  // A で操作すると自動で再接続し、同じ Identity(タブの保存トークン)で
  // 再入場して B からまた見える。
  await pageA.keyboard.press('ArrowRight');
  await expect.poll(() => remoteCount(pageB), { timeout: 15_000 }).toBe(1);
  await expect(pageA.getByText('接続を休止しています')).toBeHidden();

  await contextA.close();
  await contextB.close();
});
