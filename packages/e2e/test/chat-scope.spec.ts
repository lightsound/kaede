// fallow-ignore-file coverage-gaps -- Playwright E2E spec; drives real browsers against a live SpacetimeDB host, outside unit coverage
import {
  CHAT_SCOPE_SPACE_LABEL,
  GROUP_KIND_HUDDLE,
  HUDDLE_LEAVE_DISTANCE,
  huddleLabel,
  MAPS,
  mapFor,
} from '@kaede/shared';
import { expect, type Page, test } from '@playwright/test';
import { enterWorld, localX, netStats, sendChat, snapshot, sql, walkWhile } from './helpers';

// What this file fixes is 増分④'s core: a message goes only where its scope
// says, and a CLOSED conversation group's history never reaches a
// non-member — asserted on what crossed the wire, not on the DOM (see
// groupChatRows).

const PLAZA_NAME = mapFor(0).name;
const PORTAL_RECT = MAPS[0].portals[0].rect;

const mapId = async (page: Page) => (await snapshot(page)).mapId;
const localZone = async (page: Page) => (await snapshot(page)).local.zone;

/**
 * How many GROUP-scoped chat rows this client's subscription has been
 * handed (seed + insert events), through the dev-only net-stats hook. THE
 * privacy probe for closed conversations, for the reason dm.spec reads
 * dmRowsReceived: a line missing from a non-member's DOM would also be
 * true of a display-layer filter over rows that did arrive.
 */
async function groupChatRows(page: Page): Promise<number> {
  return (await netStats(page)).groupChatRowsReceived;
}

/**
 * Clears the conversation state every test in this file measures against —
 * through owner SQL, the guest-admission/zone precedent. The world (and its
 * retained history) is shared across specs and runs, and these assertions
 * are COUNTS of rows that must not arrive: an open group's line left over
 * from the previous run would make "the non-member received zero group
 * rows" fail for a reason that has nothing to do with the closed one. The
 * leftover huddles go too, so the join button offers this run's huddle
 * rather than a lower-id survivor of the last one (memberships re-derive
 * from movement, so dropping them costs nothing).
 */
async function resetConversations(): Promise<void> {
  await sql('DELETE FROM chat_message');
  await sql('DELETE FROM group_member');
  await sql(`DELETE FROM conversation_group WHERE kind = '${GROUP_KIND_HUDDLE}'`);
}

/**
 * Asserts a line is nowhere on the page. Not `expect(log).not.toContainText`:
 * the panel renders no log element at all while the log is empty — which is
 * exactly the state a map switch can leave behind — and an absent element
 * fails that matcher instead of satisfying it.
 */
async function expectUnseen(page: Page, text: string, timeout = 5_000): Promise<void> {
  await expect(page.getByText(text, { exact: false })).toHaveCount(0, { timeout });
}

/** Picks the send scope by the label the selector renders (see ScopeRow). */
async function pickScope(page: Page, label: string): Promise<void> {
  await page.getByRole('radio', { name: label, exact: true }).check({ timeout: 15_000 });
}

/** Sends `text` under the scope labelled `scopeLabel`. */
async function sendScoped(page: Page, scopeLabel: string, text: string): Promise<void> {
  await pickScope(page, scopeLabel);
  await sendChat(page, text);
}

/** Walks into the portal's trigger column and stops there (the map-travel routine). */
async function standInPortal(page: Page): Promise<void> {
  for (let i = 0; i < 5; i++) {
    const x = await localX(page);
    if (x >= PORTAL_RECT.x && x <= PORTAL_RECT.x + PORTAL_RECT.w) return;
    if (x < PORTAL_RECT.x) {
      await walkWhile(page, 'ArrowRight', (v) => v >= PORTAL_RECT.x);
    } else {
      await walkWhile(page, 'ArrowLeft', (v) => v <= PORTAL_RECT.x + PORTAL_RECT.w);
    }
  }
  throw new Error('could not stop inside the portal trigger');
}

/** One up-press, held across a few ticks so the 60Hz sampler cannot miss it. */
async function pressUp(page: Page): Promise<void> {
  await page.keyboard.down('ArrowUp');
  await page.waitForTimeout(150);
  await page.keyboard.up('ArrowUp');
}

// Portal walks (~1,500px at MOVE_SPEED) plus cross-browser sync polls: the
// map-travel budget reasoning for a software-rendered CI runner.
test.setTimeout(300_000);

/**
 * The map scope end to end: a 「このマップ」 message reaches the people on
 * that map, LEAVES the log when its reader teleports away (the subscription
 * is swapped with the map — the client keeps no buffer of rows the space no
 * longer hands it), does not follow them to the other map, and comes back
 * through the seed on return. 全体 rides along as the control: it crosses
 * maps throughout.
 */
test('マップスコープは同じマップにだけ届き、ポータル移動で消え、戻ると再び見える', async ({
  browser,
}) => {
  await resetConversations();
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  try {
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    await enterWorld(pageA);
    await enterWorld(pageB);
    await expect
      .poll(async () => (await snapshot(pageB)).remotePlayers.length, { timeout: 15_000 })
      .toBe(1);

    // The nonce keeps every run's assertions off the retained history of
    // the last one (the chat.spec rule).
    const nonce = Date.now().toString(36);
    const plazaLine = `広場のみんなへ ${nonce}`;
    await sendScoped(pageA, PLAZA_NAME, plazaLine);
    // The line carries its scope marker, so a reader can tell who heard it.
    await expect(pageB.getByRole('log')).toContainText(`[${PLAZA_NAME}] `, { timeout: 10_000 });
    await expect(pageB.getByRole('log')).toContainText(plazaLine, { timeout: 10_000 });

    // B takes the portal to the meeting floor: the plaza's chat is not part
    // of that map, so the line goes with the subscription.
    await standInPortal(pageB);
    await pressUp(pageB);
    await expect.poll(() => mapId(pageB), { timeout: 15_000 }).toBe(1);
    await expectUnseen(pageB, plazaLine);

    // A keeps talking to the plaza; B, a floor away, hears none of it — but
    // still hears 全体, which is what makes the negative meaningful.
    const afterLine = `まだ広場にいる人へ ${nonce}`;
    await sendScoped(pageA, PLAZA_NAME, afterLine);
    const spaceLine = `全員へ ${nonce}`;
    await sendScoped(pageA, CHAT_SCOPE_SPACE_LABEL, spaceLine);
    await expect(pageB.getByRole('log')).toContainText(spaceLine, { timeout: 10_000 });
    await expectUnseen(pageB, afterLine);

    // Returning through the paired portal re-subscribes the plaza, and the
    // retained lines arrive with the seed.
    await pressUp(pageB);
    await expect.poll(() => mapId(pageB), { timeout: 15_000 }).toBe(0);
    await expect(pageB.getByRole('log')).toContainText(afterLine, { timeout: 15_000 });
    await expect(pageB.getByRole('log')).toContainText(plazaLine);
  } finally {
    await contextA.close();
    await contextB.close();
    // Leave the shared world as found: a surviving huddle would still be on
    // the plaza when huddle.spec asserts that none are.
    await resetConversations();
  }
});

/**
 * The closed conversation group end to end — the increment's reason to
 * exist. A founds a CLOSED huddle and talks into it; B, standing right
 * next to them, is handed ZERO group rows (live and, after a reload,
 * through the subscription seed). B then joins: the same history arrives,
 * which is the positive control proving the probe can see rows at all.
 * B walks away, the server drops the membership, and row-level security
 * REVOKES the rows from B's cache — the lines leave the log without anyone
 * deleting a message.
 */
test('クローズドな会話は非メンバーに届かず、参加で届き、離脱でキャッシュから消える', async ({
  browser,
}) => {
  await resetConversations();
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  try {
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    await enterWorld(pageA);
    await enterWorld(pageB);
    await expect
      .poll(async () => (await snapshot(pageB)).remotePlayers.length, { timeout: 15_000 })
      .toBe(1);

    const nonce = Date.now().toString(36);
    const groupName = `内緒${nonce.slice(-4)}`;
    const closedLabel = huddleLabel(groupName, true);
    await pageA.getByLabel('立ち話の名前').fill(groupName);
    await pageA.getByLabel('コソコソ話す').check();
    await pageA.getByRole('button', { name: 'ここで立ち話' }).click();
    await expect.poll(() => localZone(pageA), { timeout: 15_000 }).toBe(closedLabel);

    // A speaks into the closed group. Its own log shows it under the
    // group's name; B's client is handed nothing at all.
    const secret = `ここだけの話 ${nonce}`;
    await sendScoped(pageA, groupName, secret);
    await expect(pageA.getByRole('log')).toContainText(secret, { timeout: 10_000 });
    await expect(pageA.getByRole('log')).toContainText(`[${groupName}] `);

    // The negative is timed AFTER A provably received it, so "not yet"
    // cannot masquerade as "never", and a 全体 line gives B a delivery
    // marker to wait on rather than a sleep.
    const marker = `みんなへ ${nonce}`;
    await sendScoped(pageA, CHAT_SCOPE_SPACE_LABEL, marker);
    await expect(pageB.getByRole('log')).toContainText(marker, { timeout: 10_000 });
    expect(await groupChatRows(pageB)).toBe(0);
    await expectUnseen(pageB, secret);

    // Seed-side privacy: a reloaded B re-subscribes from scratch; once the
    // public history proves the seed applied, its group row count is still
    // zero.
    await enterWorld(pageB);
    await expect(pageB.getByRole('log')).toContainText(marker, { timeout: 15_000 });
    expect(await groupChatRows(pageB)).toBe(0);
    await expectUnseen(pageB, secret);

    // B joins the huddle it was standing next to: membership is what the
    // filter reads, so the retained history arrives immediately.
    await pageB.getByRole('button', { name: `${closedLabel} に参加` }).click({ timeout: 15_000 });
    await expect.poll(() => localZone(pageB), { timeout: 15_000 }).toBe(closedLabel);
    await expect(pageB.getByRole('log')).toContainText(secret, { timeout: 15_000 });
    expect(await groupChatRows(pageB)).toBeGreaterThan(0);

    // B walks out of the conversation: the server-side walk-away rule drops
    // the membership, and the rows leave B's cache with it.
    const start = await localX(pageB);
    await walkWhile(pageB, 'ArrowRight', (x) => x >= start + HUDDLE_LEAVE_DISTANCE + 100);
    await expect.poll(() => localZone(pageB), { timeout: 15_000 }).toBeUndefined();
    await expectUnseen(pageB, secret, 15_000);
    // A, still inside, keeps its copy: this was a visibility change, not a
    // deletion.
    await expect(pageA.getByRole('log')).toContainText(secret);
  } finally {
    await contextA.close();
    await contextB.close();
    // Leave the shared world as found: a surviving huddle would still be on
    // the plaza when huddle.spec asserts that none are.
    await resetConversations();
  }
});

/**
 * The OPEN half of the same rule (VISION のオープン/クローズド): an open
 * group's conversation is visible to the room around it. B never joins and
 * stands well outside the huddle, yet receives the line — the open-group
 * filter's positive case, and the proof that the closed spec above measures
 * the closed flag rather than mere non-membership.
 */
test('オープンな会話グループの発言は非メンバーにも届く', async ({ browser }) => {
  await resetConversations();
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  try {
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    await enterWorld(pageA);
    await enterWorld(pageB);
    await expect
      .poll(async () => (await snapshot(pageB)).remotePlayers.length, { timeout: 15_000 })
      .toBe(1);

    const nonce = Date.now().toString(36);
    const groupName = `雑談${nonce.slice(-4)}`;
    await pageA.getByLabel('立ち話の名前').fill(groupName);
    await pageA.getByRole('button', { name: 'ここで立ち話' }).click();
    await expect
      .poll(() => localZone(pageA), { timeout: 15_000 })
      .toBe(huddleLabel(groupName, false));

    // B walks away first, so nothing about proximity can be mistaken for
    // membership; it is a plain bystander on the same map.
    const start = await localX(pageB);
    await walkWhile(pageB, 'ArrowRight', (x) => x >= start + HUDDLE_LEAVE_DISTANCE + 100);
    expect(await localZone(pageB)).toBeUndefined();

    const heard = `聞こえてもいい話 ${nonce}`;
    await sendScoped(pageA, groupName, heard);
    await expect(pageB.getByRole('log')).toContainText(heard, { timeout: 15_000 });
    await expect(pageB.getByRole('log')).toContainText(`[${groupName}] `);
    expect(await groupChatRows(pageB)).toBeGreaterThan(0);
  } finally {
    await contextA.close();
    await contextB.close();
    // Leave the shared world as found: a surviving huddle would still be on
    // the plaza when huddle.spec asserts that none are.
    await resetConversations();
  }
});

/**
 * The submit-time half of the selector's honesty (PR #58 の残指摘): a draft
 * typed while 会話グループ was picked must NOT be silently re-scoped to
 * 全体 when the group disappears before Enter — for a closed conversation
 * that would be a confidentiality leak. The submit refuses and keeps the
 * draft; only the NEXT, deliberate send goes where the control visibly
 * says.
 */
test('下書き中に会話グループが消えた送信は拒否され、全体へ再スコープされない', async ({
  browser,
}) => {
  await resetConversations();
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await enterWorld(page);

    const nonce = Date.now().toString(36);
    const groupName = `内緒${nonce.slice(-4)}`;
    await page.getByLabel('立ち話の名前').fill(groupName);
    await page.getByLabel('コソコソ話す').check();
    await page.getByRole('button', { name: 'ここで立ち話' }).click();
    await expect
      .poll(() => localZone(page), { timeout: 15_000 })
      .toBe(huddleLabel(groupName, true));

    // Pick the group scope and type the draft — but do not send yet.
    await pickScope(page, groupName);
    const secret = `送ってはいけない話 ${nonce}`;
    await page.getByLabel('チャット入力').fill(secret);

    // The huddle disbands under the draft (leaving a solo huddle deletes
    // it), and the group scope leaves the offered list.
    await page.getByRole('button', { name: '抜ける' }).click();
    await expect(page.getByRole('radio', { name: groupName, exact: true })).toHaveCount(0, {
      timeout: 15_000,
    });

    // Enter now must refuse — not fall back to 全体 — and keep the draft.
    await page.getByLabel('チャット入力').press('Enter');
    await expect(page.getByText('選択していた送信先が無くなった')).toBeVisible();
    await expect(page.getByLabel('チャット入力')).toHaveValue(secret);

    // A delivery marker proves the send path still flows after the refusal
    // (the pick snapped to the visible 全体), and the secret reached nobody
    // — not even the sender's own log.
    const marker = `送信できる話 ${nonce}`;
    await sendChat(page, marker);
    await expect(page.getByRole('log')).toContainText(marker, { timeout: 10_000 });
    await expectUnseen(page, secret);
  } finally {
    await context.close();
    await resetConversations();
  }
});
