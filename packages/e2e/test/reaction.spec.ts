// fallow-ignore-file coverage-gaps -- Playwright E2E spec; drives real browsers against a live SpacetimeDB host, outside unit coverage
import { REACTION_DURATION_MS } from '@kaede/shared';
import { expect, type Page, test } from '@playwright/test';
import { enterWorld, snapshot } from './helpers';

/** Clicks the palette button for `emoji` (the ChatPanel reaction row). */
async function sendReaction(page: Page, emoji: string): Promise<void> {
  await page.getByLabel(`リアクション ${emoji}`).click();
}

/**
 * Emoji reactions end to end (ROADMAP Phase 2): a reaction sent from one
 * browser shows above the sender's avatar on BOTH sides of the wire (the
 * sender's own display round-trips through the row event too), a second
 * reaction replaces the first (the identity-keyed upsert row arrives as an
 * UPDATE event, the schema's other display path), the badge hides once its
 * display window elapses, and a reload does not replay it — the row
 * persists server-side, but display is event-only (the bubble seed/event
 * rule). Reactions are canvas-drawn, so all assertions go through the
 * __kaedeE2E snapshot hook (the bubble precedent).
 *
 * No nonce is needed, unlike the chat spec's messages: leftover reaction
 * rows from previous runs never display (seeds don't render), and only row
 * events fired during this session can satisfy the polls.
 */
test('リアクションが両画面のアバター頭上に表示され、連打で置き換わり、時間経過で消え、リロードで再表示されない', async ({
  browser,
}) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  await enterWorld(pageA);
  await enterWorld(pageB);

  // B must see A before the reaction, so the assertions below measure
  // reaction propagation and not mere entry.
  await expect
    .poll(async () => (await snapshot(pageB)).remotePlayers.length, { timeout: 15_000 })
    .toBe(1);

  await sendReaction(pageA, '👍');

  // The send round-trips through the server row before anything renders:
  // A's own badge and B's view of it come from the same row event.
  await expect
    .poll(async () => (await snapshot(pageA)).local.reaction, { timeout: 10_000 })
    .toBe('👍');
  await expect
    .poll(async () => (await snapshot(pageB)).remotePlayers[0]?.reaction, { timeout: 10_000 })
    .toBe('👍');

  // A second reaction REPLACES the first mid-display: the upsert row makes
  // it an update event, the other half of the display wiring (onInsert
  // covered above, onUpdate here).
  await sendReaction(pageA, '🎉');
  await expect
    .poll(async () => (await snapshot(pageA)).local.reaction, { timeout: 10_000 })
    .toBe('🎉');
  await expect
    .poll(async () => (await snapshot(pageB)).remotePlayers[0]?.reaction, { timeout: 10_000 })
    .toBe('🎉');

  // Transient: gone from both screens once the display window elapses.
  await expect
    .poll(async () => (await snapshot(pageA)).local.reaction, {
      timeout: REACTION_DURATION_MS + 10_000,
    })
    .toBeUndefined();
  await expect
    .poll(async () => (await snapshot(pageB)).remotePlayers[0]?.reaction, {
      timeout: REACTION_DURATION_MS + 10_000,
    })
    .toBeUndefined();

  // A fresh navigation resumes the same identity and re-seeds the reaction
  // row through the initial subscription — but seeds never display: only
  // someone reacting NOW does.
  await enterWorld(pageA);
  expect((await snapshot(pageA)).local.reaction).toBeUndefined();

  await contextA.close();
  await contextB.close();
});
