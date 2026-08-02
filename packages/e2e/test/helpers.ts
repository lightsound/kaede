// fallow-ignore-file coverage-gaps -- Playwright E2E helpers; drive real browsers against a live SpacetimeDB host, outside unit coverage
import type { E2EWorldSnapshot } from '@maple/shared';
import type { Page } from '@playwright/test';

/** Reads the world through the client's read-only test hook (see e2eHook.ts). */
export function snapshot(page: Page): Promise<E2EWorldSnapshot> {
  return page.evaluate(() => {
    const hook = window.__mapleE2E;
    if (!hook) throw new Error('__mapleE2E hook is not installed');
    return hook.snapshot();
  });
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
  await page.waitForFunction(() => (window.__mapleE2E?.snapshot().tick ?? -1) >= 0);
}
