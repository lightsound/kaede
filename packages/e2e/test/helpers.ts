// fallow-ignore-file coverage-gaps -- Playwright E2E helpers; drive real browsers against a live SpacetimeDB host, outside unit coverage
import type { E2ENetStats, E2EWorldSnapshot } from '@kaede/shared';
import type { Page } from '@playwright/test';

/** Reads the world through the client's read-only test hook (see e2eHook.ts). */
export function snapshot(page: Page): Promise<E2EWorldSnapshot> {
  return page.evaluate(() => {
    const hook = window.__kaedeE2E;
    if (!hook) throw new Error('__kaedeE2E hook is not installed');
    return hook.snapshot();
  });
}

/**
 * Reads the net-layer counters (sync.ts の dev 限定フック) as one value
 * snapshot. What the invisible-by-design assertions read: sends stopping
 * (idle suppression), DM rows NOT arriving (privacy), notification
 * decisions (OS notifications are unobservable from a test).
 */
export function netStats(page: Page): Promise<E2ENetStats> {
  return page.evaluate(() => {
    const stats = window.__kaedeE2ENet;
    if (!stats) throw new Error('__kaedeE2ENet hook is not installed');
    return { ...stats };
  });
}

/** Fills the chat input and submits (Enter, like a chat box should). */
export async function sendChat(page: Page, text: string): Promise<void> {
  await page.getByLabel('チャット入力').fill(text);
  await page.getByLabel('チャット入力').press('Enter');
}

/**
 * Guest entry: load the client and wait until the authoritative spawn row has
 * started the local simulation (covers connect → join → own-row round trip).
 * `tick` is -1 until that moment, so the wait stays correct no matter when
 * the hook itself gets installed. `path` admits dev-only query overrides
 * (e.g. `/?idleMs=3000` for the idle-suspension spec).
 */
export async function enterWorld(page: Page, path = '/'): Promise<void> {
  await page.goto(path);
  await page.waitForFunction(() => (window.__kaedeE2E?.snapshot().tick ?? -1) >= 0);
}
