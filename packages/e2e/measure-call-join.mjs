// fallow-ignore-file coverage-gaps -- a hand-run measurement probe driving real browsers against a live stack (like the Playwright specs); the numbers it produces are recorded in docs/ROADMAP.md 増分⑤
// fallow-ignore-file unused-file -- run by hand with `node measure-call-join.mjs`, never imported (the alchemy.run.ts precedent)
// Call-join phase breakdown measurement (ROADMAP Phase 4.5 増分⑤).
// NOT part of the test suite — a standalone probe run by hand:
//   node measure-call-join.mjs <targetUrl> <label> [rounds]
// Drives two guest browsers: A founds a huddle and joins the call (the
// provision path — meeting creation + token mint), B joins the same
// huddle and then the call (the reuse path — token mint only). Phases
// are cut from the network event stream:
//   ⑴ join_group_call procedure = click → first provider traffic
//   ⑵ SDK init + WebRTC join    = first provider traffic → lazy chunk request
//   ⑶ chunk download + render   = lazy chunk request → <rtk-grid> attached
import { chromium } from '@playwright/test';

const target = process.argv[2] ?? 'http://localhost:4173';
const label = process.argv[3] ?? 'local';
const rounds = Number(process.argv[4] ?? '3');
const origin = new URL(target).origin;

/** Domains that are neither the app nor the call provider (noise). */
const NOISE = ['clerk', 'posthog', 'spacetimedb.com', 'localhost:3000', '127.0.0.1:3000'];
const isNoise = (url) => NOISE.some((n) => new URL(url).host.includes(n));

function attachProbes(page) {
  const events = [];
  const push = (kind, url, extra = {}) => events.push({ t: Date.now(), kind, url, ...extra });
  page.on('request', (req) => push('request', req.url()));
  page.on('websocket', (ws) => {
    push('ws-open', ws.url());
    ws.on('framesent', (f) => push('ws-sent', ws.url(), { size: (f.payload ?? '').length }));
    ws.on('framereceived', (f) => push('ws-recv', ws.url(), { size: (f.payload ?? '').length }));
  });
  return events;
}

/**
 * Waits for the matched button to exist and be enabled, then clicks it
 * when `click` is set — the click happens inside the same poll, so there
 * is one in-page finder for both uses (matched by exact text or suffix).
 */
async function onButton(page, match, click, timeout = 90_000) {
  await page.waitForFunction(
    (m) => {
      const btn = [...document.querySelectorAll('button')].find((b) =>
        m.exact ? b.textContent === m.exact : b.textContent?.endsWith(m.suffix ?? ''),
      );
      if (btn === undefined || btn.disabled) return false;
      if (m.click) btn.click();
      return true;
    },
    { ...match, click },
    { timeout },
  );
}

/** A probed guest page, entered into the world (the huddle form is up). */
async function enterWorld(ctx) {
  const page = await ctx.newPage();
  const events = attachProbes(page);
  await page.goto(target);
  await onButton(page, { exact: 'ここで立ち話' }, false);
  return { page, events };
}

/** One measured join: click 📞, wait for the in-call grid, cut the phases. */
async function measureJoin(page, events, role) {
  await onButton(page, { exact: '📞 通話に参加' }, false);
  const t0 = Date.now();
  await onButton(page, { exact: '📞 通話に参加' }, true);
  await page.waitForSelector('rtk-grid', { state: 'attached', timeout: 90_000 });
  const t3 = Date.now();

  const window_ = events.filter((e) => e.t >= t0 && e.t <= t3);
  const chunk = window_.find(
    (e) =>
      e.kind === 'request' &&
      e.url.startsWith(origin) &&
      /\.js(\?|$)/.test(new URL(e.url).pathname),
  );
  const provider = window_.find(
    (e) =>
      (e.kind === 'request' || e.kind === 'ws-open') &&
      !e.url.startsWith(origin) &&
      !isNoise(e.url) &&
      (chunk === undefined || e.t <= chunk.t),
  );
  // With the dock-shown warm-up (増分⑤) the chunk is downloaded before
  // the click, so no same-origin js request appears in the window: ⑶ is
  // zero and ⑵ runs to the grid attach.
  const sample = {
    label,
    role,
    total: t3 - t0,
    p1_procedure: provider ? provider.t - t0 : undefined,
    p2_webrtc: provider ? (chunk ? chunk.t : t3) - provider.t : undefined,
    p3_chunk: chunk ? t3 - chunk.t : 0,
    providerFirstUrl: provider?.url,
    chunkUrl: chunk?.url,
  };
  console.log(JSON.stringify(sample));
  if (process.env.DEBUG_EVENTS) {
    for (const e of window_) console.error(`  +${e.t - t0}ms ${e.kind} ${e.url.slice(0, 120)}`);
  }
  return sample;
}

const browser = await chromium.launch({
  headless: true,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});

for (let round = 0; round < rounds; round++) {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  try {
    const a = await enterWorld(ctxA);
    await onButton(a.page, { exact: 'ここで立ち話' }, true);
    await measureJoin(a.page, a.events, 'provision');

    // B spawns where A founded the huddle, so the join offer is up.
    const b = await enterWorld(ctxB);
    await onButton(b.page, { suffix: ' に参加' }, true);
    await measureJoin(b.page, b.events, 'reuse');
  } catch (err) {
    console.error(`round ${round} failed:`, err);
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
}

await browser.close();
