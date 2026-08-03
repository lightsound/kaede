// fallow-ignore-file coverage-gaps -- Playwright E2E spec; drives real browsers against a live SpacetimeDB host, outside unit coverage
import { CHAT_BUBBLE_DURATION_MS } from '@maple/shared';
import { expect, type Page, test } from '@playwright/test';
import { enterWorld, snapshot } from './helpers';

/** Fills the chat input and submits (Enter, like a chat box should). */
async function sendChat(page: Page, text: string): Promise<void> {
  await page.getByLabel('チャット入力').fill(text);
  await page.getByLabel('チャット入力').press('Enter');
}

/**
 * The global-scope chat end to end (ROADMAP Phase 2 第一弾): a message sent
 * from one browser reaches the other browser's log AND shows as a speech
 * bubble over the sender's avatar, the reply makes it a conversation, the
 * bubble hides after its display window, and a reload still shows the
 * history (the server retains the newest CHAT_HISTORY_MAX rows, and the
 * initial subscription replays them). The log is DOM, asserted with
 * locators; bubbles are canvas-drawn, asserted through the __mapleE2E
 * snapshot hook (the remotePlayers precedent).
 *
 * Message texts carry a nonce: the world (and its retained history) is
 * shared across specs and runs, so a fixed string could pass on a previous
 * run's leftovers.
 */
test('チャットが相手のログと吹き出しに届き、返信で会話が成立し、リロード後も履歴が残る', async ({
  browser,
}) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  await enterWorld(pageA);
  await enterWorld(pageB);

  // B must see A before the chat, so the assertions below measure message
  // propagation and not mere entry.
  await expect
    .poll(async () => (await snapshot(pageB)).remotePlayers.length, { timeout: 15_000 })
    .toBe(1);

  const nonce = Date.now();
  const messageA = `こんにちは、かえで! ${nonce}`;
  const messageB = `こちらこそ、よろしく ${nonce}`;

  await sendChat(pageA, messageA);

  // The send round-trips through the server row before anything renders:
  // A's own log line and bubble come from the same subscription event
  // everyone else gets.
  await expect(pageA.getByRole('log')).toContainText(messageA, { timeout: 10_000 });
  await expect(pageB.getByRole('log')).toContainText(messageA, { timeout: 10_000 });

  // The speech bubble, on both sides of the wire: over A's own avatar, and
  // over A's remote avatar as B renders it.
  await expect
    .poll(async () => (await snapshot(pageA)).local.bubble, { timeout: 10_000 })
    .toBe(messageA);
  await expect
    .poll(async () => (await snapshot(pageB)).remotePlayers[0]?.bubble, { timeout: 10_000 })
    .toBe(messageA);

  // The reply completes the conversation (Phase 2 の完了条件の会話成立).
  await sendChat(pageB, messageB);
  await expect(pageA.getByRole('log')).toContainText(messageB, { timeout: 10_000 });
  await expect
    .poll(async () => (await snapshot(pageA)).remotePlayers[0]?.bubble, { timeout: 10_000 })
    .toBe(messageB);

  // Bubbles are transient: gone once the display window elapses (the log
  // keeps the text).
  await expect
    .poll(async () => (await snapshot(pageB)).remotePlayers[0]?.bubble, {
      timeout: CHAT_BUBBLE_DURATION_MS + 10_000,
    })
    .toBeUndefined();

  // A fresh navigation resumes the same identity and replays the retained
  // history through the initial subscription — but no bubbles: history is
  // not someone speaking now.
  await enterWorld(pageA);
  await expect(pageA.getByRole('log')).toContainText(messageA);
  await expect(pageA.getByRole('log')).toContainText(messageB);
  expect((await snapshot(pageA)).local.bubble).toBeUndefined();

  await contextA.close();
  await contextB.close();
});
