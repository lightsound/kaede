// fallow-ignore-file coverage-gaps -- Playwright E2E helpers; drive real browsers against a live SpacetimeDB host, outside unit coverage
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { E2ENetStats, E2EWorldSnapshot } from '@kaede/shared';
import { expect, type Page } from '@playwright/test';

const exec = promisify(execFile);

/**
 * The pinned CLI ships as `spacetimedb-cli` in CI (see ci.yml) while the
 * official installer names it `spacetime`; SPACETIME_BIN picks the former
 * where it applies.
 */
const SPACETIME_BIN = process.env.SPACETIME_BIN ?? 'spacetime';

/**
 * Writes to the module's database as its owner, which is how specs play
 * admin (flipping settings, seeding zones): the real admin reducers need
 * an approved admin member, and member identities require a Clerk sign-in,
 * which stays out of E2E (see display-name.spec.ts). Subscribed clients
 * see SQL writes exactly like reducer writes, so the reactive paths under
 * test are the real ones.
 */
export async function sql(query: string): Promise<void> {
  await exec(SPACETIME_BIN, ['sql', 'kaede', query, '--server', 'local']);
}

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

/** The local player's rendered x, through the snapshot hook. */
export async function localX(page: Page): Promise<number> {
  return (await snapshot(page)).local.x;
}

/**
 * Holds a horizontal key until the local prediction satisfies `done`, then
 * releases. The key is held until the position actually passes (not for a
 * fixed duration), so a low-FPS CI renderer — where MAX_FRAME caps how much
 * simulation each frame may advance — only makes the walk take longer,
 * never fail. Tight poll intervals keep the release overshoot small.
 */
export async function walkWhile(
  page: Page,
  key: 'ArrowLeft' | 'ArrowRight',
  done: (x: number) => boolean,
): Promise<void> {
  await page.keyboard.down(key);
  try {
    await expect
      .poll(async () => done(await localX(page)), { timeout: 60_000, intervals: [50] })
      .toBe(true);
  } finally {
    await page.keyboard.up(key);
  }
}
