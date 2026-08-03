// fallow-ignore-file coverage-gaps -- Playwright E2E spec; drives real browsers against a live SpacetimeDB host, outside unit coverage
import { expect, type Page, test } from '@playwright/test';
import { enterWorld, netStats, snapshot } from './helpers';

const remoteCount = async (page: Page) => (await snapshot(page)).remotePlayers.length;
/** The single remote player's x, or undefined during a transient empty list. */
const remoteX = async (page: Page) => (await snapshot(page)).remotePlayers[0]?.x;

/**
 * 送信が止まる(=静止に到達し全バッチが ack された)まで待つ。入場直後は
 * スポーンからの落下を送り切るまで空入力が流れるので、「1.2秒(フラッシュ
 * 3回ぶん)カウンタが動かない」ことをもって静止とみなす。
 */
async function settleSends(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        const before = (await netStats(page)).inputBatchesSent;
        await page.waitForTimeout(1200);
        const after = (await netStats(page)).inputBatchesSent;
        return after - before;
      },
      { timeout: 30_000 },
    )
    .toBe(0);
}

test('静止中は送信が完全に止まり、行は残り、移動再開で同期が復帰する', async ({ browser }) => {
  // 2 コンテキスト = 別々のゲスト Identity。B は観測者: 抑制中でも A の
  // 行が掃除されず見え続けること、再開後に A の移動が届くことを見る。
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  await enterWorld(pageA);
  await enterWorld(pageB);
  await expect.poll(() => remoteCount(pageB), { timeout: 15_000 }).toBe(1);

  // 静止到達まで(落下・着地の同期を送り切るまで)は送信が続いてよい。
  await settleSends(pageA);

  // 静止中: 入力バッチは 1 本も送られない(これが「静止中 0 calls/秒」の
  // 実測そのもの)。ハートビートは差分で見る — 入場時の生存宣言 1 本が
  // 絶対値に乗るのに対し、定期便は 2 分間隔なのでこの窓では増えない。
  const idleBefore = await netStats(pageA);
  await pageA.waitForTimeout(3000);
  const idleAfter = await netStats(pageA);
  expect(idleAfter.inputBatchesSent).toBe(idleBefore.inputBatchesSent);
  expect(idleAfter.heartbeatsSent).toBe(idleBefore.heartbeatsSent);

  // 送信ゼロでも A の行は生きていて、B からは見え続ける(オフライン掃除
  // との相互作用の検証: 抑制が sweep を誘発しない)。
  expect(await remoteCount(pageB)).toBe(1);

  // 移動再開: 抑制中に飛ばした tick は startTick のギャップとして届く。
  // サーバーのギャップ受理が壊れていると B の見る A は動かない。
  const bView = (await remoteX(pageB)) ?? Number.NEGATIVE_INFINITY;
  await pageA.keyboard.down('ArrowRight');
  await pageA.waitForTimeout(1500);
  await pageA.keyboard.up('ArrowRight');

  const moved = await netStats(pageA);
  const movingBatches = moved.inputBatchesSent - idleAfter.inputBatchesSent;
  expect(movingBatches).toBeGreaterThan(0);
  // 移動中のレートは目標帯(2〜3 calls/秒)+末尾フラッシュに収まる:
  // 1.5 秒の移動で高々 3*1.5 + 2 本。
  expect(movingBatches).toBeLessThanOrEqual(7);

  await expect
    .poll(async () => (await remoteX(pageB)) ?? Number.NEGATIVE_INFINITY, { timeout: 15_000 })
    .toBeGreaterThan(bView + 100);

  // 停止すると再び完全に黙る(減速・着地ぶんを送り切ってから)。
  await settleSends(pageA);
  const again = await netStats(pageA);
  await pageA.waitForTimeout(3000);
  expect((await netStats(pageA)).inputBatchesSent).toBe(again.inputBatchesSent);

  await contextA.close();
  await contextB.close();
});
