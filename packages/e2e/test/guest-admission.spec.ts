// fallow-ignore-file coverage-gaps -- Playwright E2E spec; drives real browsers against a live SpacetimeDB host, outside unit coverage
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { enterWorld, snapshot } from './helpers';

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

/**
 * Replaces the settings singleton (id 0). Only safe while no browser under
 * test is connected: between the DELETE and the INSERT the row is missing,
 * which reads as the default (guests allowed) to live subscribers.
 */
async function seedGuestsAllowed(allowed: boolean): Promise<void> {
  await sql('DELETE FROM space_setting WHERE id = 0');
  await sql(`INSERT INTO space_setting (id, guests_allowed) VALUES (0, ${allowed})`);
}

/** Flips the seeded singleton in one atomic statement; safe mid-test. */
async function setGuestsAllowed(allowed: boolean): Promise<void> {
  await sql(`UPDATE space_setting SET guests_allowed = ${allowed} WHERE id = 0`);
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
  await seedGuestsAllowed(false);
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

/**
 * The other half of the setting: guests already in the world are expelled
 * the moment guests are disallowed — through the admission re-check every
 * submit_inputs performs (reducers.ts) — their client stops the local
 * simulation and shows the refusal, and re-allowing lets them walk right
 * back in without a reload. The real set_guests_allowed reducer sweeps
 * guests in the same transaction as the flip, but this spec flips through
 * raw SQL (an admin member would need a Clerk sign-in), which runs no
 * reducer; pressing a key makes the client send one input batch, and the
 * server's own admission re-check deletes the row. That nudge became
 * necessary with idle suppression: a still client sends nothing the server
 * could rule on (pre-suppression, the 100ms input stream tripped the same
 * re-check within a tick, which is what this spec's kick used to observe).
 */
test('入場中のゲストは不許可への切替で即キックされ、再許可で自動的に復帰する', async ({
  browser,
}) => {
  // Seed the singleton while nothing is connected, so the flips below can be
  // single atomic UPDATEs.
  await seedGuestsAllowed(true);
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await enterWorld(page);

    await setGuestsAllowed(false);
    // 送信ゲートを1回開けて、サーバーの admission 再チェックに行を消させる。
    await page.keyboard.press('ArrowRight');

    // Expelled: the refusal notice covers the world, and the local
    // simulation is re-gated (tick returns to -1, the not-in-world signal),
    // so the kicked client cannot keep walking a ghost around.
    await expect(page.getByText('ゲスト入場は現在許可されていません')).toBeVisible({
      timeout: 15_000,
    });
    await expect.poll(async () => (await snapshot(page)).tick, { timeout: 10_000 }).toBe(-1);

    // Re-allowing readmits the kicked client on its own, no reload needed.
    await setGuestsAllowed(true);
    await page.waitForFunction(() => (window.__mapleE2E?.snapshot().tick ?? -1) >= 0, undefined, {
      timeout: 15_000,
    });
    await expect(page.getByText('ゲスト入場は現在許可されていません')).toBeHidden();

    await context.close();
  } finally {
    await setGuestsAllowed(true);
  }
});
