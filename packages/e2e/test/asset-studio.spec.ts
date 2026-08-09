// fallow-ignore-file coverage-gaps -- Playwright E2E spec; drives a real browser against the Vite dev server, outside unit coverage
import { expect, test } from '@playwright/test';

/**
 * The dev-only asset studio (Phase 5 ①b⑷ — the read-only inspection
 * viewer at /assets). No SpacetimeDB dependency: the page renders the
 * bundled manifests without ever connecting, so this spec asserts pure
 * client behavior — the roster renders complete, the missing-pose
 * detection reports clean on the shipped assets, and the walk playback
 * actually cycles frames on the rig cadence.
 */
test('アセット検品ビューアが全キャラ・全アイテムを描画し、歩行再生と比較が機能する', async ({
  page,
}) => {
  await page.goto('/assets');
  await expect(page.getByTestId('asset-studio')).toBeVisible({ timeout: 15_000 });

  // The full roster: 4 avatar-body sheets × 5 poses each, 5 held items.
  await expect(page.getByTestId('avatar-card')).toHaveCount(4);
  await expect(page.getByTestId('pose-frame')).toHaveCount(20);
  await expect(page.getByTestId('item-card')).toHaveCount(5);
  // The carry variants ship a hand overlay (the mitten-over-item layer).
  await expect(page.getByTestId('hand-layer')).toHaveCount(2);

  // The shipped manifests share one pose vocabulary, so the diff is clean —
  // and no integrity problem (missing PNG, duplicate id) is reported.
  await expect(page.getByTestId('missing-summary')).toContainText('ポーズ欠落なし');
  await expect(page.getByTestId('problems')).toHaveCount(0);

  // Walk playback cycles the preview through the walk frames (200ms per
  // frame at the rig cadence, so half a second sees a frame change), and
  // pausing settles every preview back on stand.
  const firstPreview = page.getByTestId('walk-preview').first();
  await expect
    .poll(async () => firstPreview.getAttribute('data-pose'), { timeout: 10_000 })
    .toMatch(/^walk-/);
  await page.getByTestId('playback-toggle').click();
  await expect(firstPreview).toHaveAttribute('data-pose', 'stand');

  // Checking two avatars builds the comparison strip with both figures.
  await page.getByTestId('avatar-card').first().getByRole('checkbox').check();
  await page.getByTestId('avatar-card').nth(1).getByRole('checkbox').check();
  const strip = page.getByTestId('compare-strip');
  await expect(strip).toBeVisible();
  await expect(strip.getByTestId('walk-preview')).toHaveCount(2);

  // The dress-up stage: default look is the first outfit (the basic boy)
  // with empty hands; clicking an outfit swaps the whole body sheet, and
  // clicking an item swaps to the outfit's carry variant with the item
  // (plus the sheet's hand cutout) composited over it — the ①b(a)⑵
  // one-decision rule. Clicking the item again puts it back.
  const figure = page.getByTestId('stage-figure');
  await expect(figure).toHaveAttribute('data-body', 'avatar.boy-basic');
  await expect(page.getByTestId('stage-overlay')).toHaveCount(0);
  await page.getByTestId('outfit-option-avatar.boy-basic-red').click();
  await expect(figure).toHaveAttribute('data-body', 'avatar.boy-basic-red');
  await page.getByTestId('item-option-item.coffee-mug').click();
  await expect(figure).toHaveAttribute('data-body', 'avatar.boy-basic-red-carry');
  await expect(page.getByTestId('stage-overlay')).toHaveCount(2);
  await page.getByTestId('item-option-item.coffee-mug').click();
  await expect(figure).toHaveAttribute('data-body', 'avatar.boy-basic-red');
  await expect(page.getByTestId('stage-overlay')).toHaveCount(0);
});
