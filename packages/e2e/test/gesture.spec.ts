// fallow-ignore-file coverage-gaps -- Playwright E2E spec; drives real browsers against a live SpacetimeDB host, outside unit coverage
import { expect, type Page, test } from '@playwright/test';
import { enterWorld, snapshot } from './helpers';

/** Clicks the gesture button labelled `label` (the ChatPanel GestureRow). */
async function playGesture(page: Page, label: string): Promise<void> {
  await page.getByLabel(`ジェスチャー ${label}`).click();
}

/** The pose the local avatar shows (avatarView.pose() via the snapshot hook). */
async function localPose(page: Page): Promise<string | undefined> {
  return (await snapshot(page)).local.pose;
}

/** The pose B renders for its one remote player (A). */
async function remotePose(page: Page): Promise<string | undefined> {
  return (await snapshot(page)).remotePlayers[0]?.pose;
}

/**
 * The pose gestures end to end (ROADMAP Phase 5 ①c): striking 座る renders
 * the sit pose on BOTH sides of the wire (the sender's own pose
 * round-trips through the gesture row event too), a reload restores it
 * (state gestures follow the status seed rule, the opposite of
 * reactions), WALKING CANCELS IT SERVER-SIDE (the ①c "歩き出したら解除"
 * decision — the row delete reaches both screens), the transient 手を振る
 * reverts by itself without any movement, and the away status derives the
 * sleep pose with no gesture row at all. Poses are canvas-drawn, so all
 * assertions go through the __kaedeE2E snapshot hook (the status-spec
 * precedent).
 */
test('ジェスチャーが両画面に反映され、リロードで復元、移動で解除、手を振るは自動で戻る', async ({
  browser,
}) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  await enterWorld(pageA);
  await enterWorld(pageB);

  // B must see A before the gesture, so the assertions measure gesture
  // propagation and not mere entry.
  await expect
    .poll(async () => (await snapshot(pageB)).remotePlayers.length, { timeout: 15_000 })
    .toBe(1);

  // 座る: the pose round-trips through the server row on both sides.
  await playGesture(pageA, '座る');
  await expect.poll(() => localPose(pageA), { timeout: 10_000 }).toBe('sit');
  await expect.poll(() => remotePose(pageB), { timeout: 10_000 }).toBe('sit');

  // A state gesture survives a reload: the fresh subscription's seed
  // restores the pose (the player_status precedent; a reaction must never
  // do this). B keeps seeing it once A's row flips back online.
  await enterWorld(pageA);
  await expect.poll(() => localPose(pageA), { timeout: 10_000 }).toBe('sit');
  await expect.poll(() => remotePose(pageB), { timeout: 10_000 }).toBe('sit');

  // 歩き出したら解除 (server-side): real movement deletes the row — the
  // walk frames take over immediately, and after stopping BOTH sides
  // settle on stand, because the authority cleared the gesture (no client
  // ever sent a clear).
  await pageA.keyboard.down('ArrowRight');
  await pageA.waitForTimeout(600);
  await pageA.keyboard.up('ArrowRight');
  await expect.poll(() => localPose(pageA), { timeout: 10_000 }).toBe('stand');
  await expect.poll(() => remotePose(pageB), { timeout: 10_000 }).toBe('stand');

  // ダンス: a state gesture whose pose cycles through the dance frames.
  await playGesture(pageA, 'ダンス');
  await expect.poll(() => localPose(pageA), { timeout: 10_000 }).toMatch(/^dance-/);
  await expect.poll(() => remotePose(pageB), { timeout: 10_000 }).toMatch(/^dance-/);
  await pageA.keyboard.down('ArrowLeft');
  await pageA.waitForTimeout(600);
  await pageA.keyboard.up('ArrowLeft');
  await expect.poll(() => localPose(pageA), { timeout: 10_000 }).toBe('stand');

  // 手を振る: transient — it plays on both sides, then reverts to stand by
  // itself (WAVE_GESTURE_DURATION_MS) with no movement and no clear call.
  await playGesture(pageA, '手を振る');
  await expect.poll(() => localPose(pageA), { timeout: 10_000 }).toBe('wave');
  await expect.poll(() => remotePose(pageB), { timeout: 10_000 }).toBe('wave');
  await expect.poll(() => localPose(pageA), { timeout: 10_000 }).toBe('stand');
  await expect.poll(() => remotePose(pageB), { timeout: 10_000 }).toBe('stand');

  // 離席＝寝る: the derived pose needs no gesture row — the availability
  // switch alone lies the avatar down on both sides, and switching back
  // stands it up (the ①c status-visualization rule).
  await pageA.getByLabel('ステータス 離席').click();
  await expect.poll(() => localPose(pageA), { timeout: 10_000 }).toBe('sleep');
  await expect.poll(() => remotePose(pageB), { timeout: 10_000 }).toBe('sleep');
  await pageA.getByLabel('ステータス オンライン').click();
  await expect.poll(() => localPose(pageA), { timeout: 10_000 }).toBe('stand');
  await expect.poll(() => remotePose(pageB), { timeout: 10_000 }).toBe('stand');

  await contextA.close();
  await contextB.close();
});
