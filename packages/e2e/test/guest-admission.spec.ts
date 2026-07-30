// fallow-ignore-file coverage-gaps -- Playwright E2E spec; drives real browsers against a live SpacetimeDB host, outside unit coverage
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { snapshot } from './helpers';

const exec = promisify(execFile);

/**
 * The pinned CLI ships as `spacetimedb-cli` in CI (see ci.yml) while the
 * official installer names it `spacetime`; SPACETIME_BIN picks the former
 * where it applies.
 */
const SPACETIME_BIN = process.env.SPACETIME_BIN ?? 'spacetime';

/**
 * Writes to the module's database as its owner, which is how this spec plays
 * admin: flipping the setting through the set_guests_allowed reducer needs
 * an approved admin member, and member identities require a Clerk sign-in,
 * which stays out of E2E (see display-name.spec.ts). Subscribed clients see
 * SQL writes exactly like reducer writes, so the reactive paths under test
 * are the real ones.
 */
async function sql(query: string): Promise<void> {
  await exec(SPACETIME_BIN, ['sql', 'maple-like', query, '--server', 'local']);
}

/** Sets the guest-admission flag by replacing the settings singleton (id 0). */
async function setGuestsAllowed(allowed: boolean): Promise<void> {
  await sql('DELETE FROM space_setting WHERE id = 0');
  await sql(`INSERT INTO space_setting (id, guests_allowed) VALUES (0, ${allowed})`);
}

/**
 * The guest-admission setting end to end (ROADMAP Phase 1: ゲスト入場の
 * 許可/不許可): with guests disallowed a fresh guest is refused — the notice
 * shows and no world entry happens — and re-allowing lets the same waiting
 * client enter on its own (the space_setting subscription drives the join;
 * no reload needed). The member paths (waiting room, approval, removal) are
 * covered by @maple/shared unit tests instead, since they need Clerk
 * identities.
 */
test('ゲスト入場を不許可にすると入場できず、再許可で自動的に入場する', async ({ browser }) => {
  await setGuestsAllowed(false);
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('/');

    // The refusal notice is the UI contract for a held guest.
    await expect(page.getByText('ゲスト入場は現在許可されていません')).toBeVisible({
      timeout: 15_000,
    });
    // And no world entry happened: the e2e hook only installs when the local
    // simulation starts, i.e. after an (unwanted) successful join.
    expect(await page.evaluate(() => window.__mapleE2E?.snapshot().tick ?? -1)).toBe(-1);

    // Re-allowing must admit the waiting client without a reload: the
    // setting row flips in its subscription and the client joins itself.
    await setGuestsAllowed(true);
    await page.waitForFunction(() => (window.__mapleE2E?.snapshot().tick ?? -1) >= 0, undefined, {
      timeout: 15_000,
    });
    await expect(page.getByText('ゲスト入場は現在許可されていません')).toBeHidden();
    expect((await snapshot(page)).tick).toBeGreaterThanOrEqual(0);

    await context.close();
  } finally {
    // The world and its settings are shared by every spec: leave guests
    // allowed (the default) for whatever runs next, even on failure/retry.
    await setGuestsAllowed(true);
  }
});
