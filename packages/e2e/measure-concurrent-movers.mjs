// fallow-ignore-file coverage-gaps -- a hand-run measurement probe driving real browsers plus headless SDK bots against a live stack (like measure-call-join.mjs)
// fallow-ignore-file unused-file -- run by hand with `node measure-concurrent-movers.mjs`, never imported
// Concurrent-mover load probe (VISION target: 同時接続 最大〜50人).
// NOT part of the test suite. Bundles the headless guest bots, opens one
// observer browser (the thing a real member would feel), and samples FPS /
// remote count / inbound player-row rate while N bots walk.
//
// Prerequisites (same as the Playwright specs):
//   spacetimedb-cli start
//   spacetimedb-cli publish kaede --server local --yes
//   pnpm --filter @kaede/client dev   (or let this script's webServer-less
//     observer hit an already-running Vite; pass --target if needed)
//
//   node measure-concurrent-movers.mjs --count 20 --movers 20 --seconds 20
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '../..');
const clientDir = join(repoRoot, 'packages/client');
const runSource = join(clientDir, 'src/load.package/run.ts');
const bundleOut = join(clientDir, '.load-movers.bundle.mjs');

function argValue(args, name, fallback) {
  const i = args.indexOf(name);
  if (i < 0 || args[i + 1] === undefined) return fallback;
  return args[i + 1];
}

const args = process.argv.slice(2);
const count = Number(argValue(args, '--count', '20'));
const movers = Number(argValue(args, '--movers', String(count)));
const seconds = Number(argValue(args, '--seconds', '20'));
const target = argValue(args, '--target', 'http://localhost:5173');
const outFile = argValue(args, '--out', join('/tmp', `kaede-load-${count}x${movers}.json`));
const artifactsDir = argValue(args, '--artifacts', '/opt/cursor/artifacts');
const staggerMs = argValue(args, '--stagger-ms', '40');
const label = argValue(args, '--label', `${count}n-${movers}m`);

function requireFrom(fromFile, spec) {
  return createRequire(fromFile).resolve(spec);
}

async function bundleBots() {
  const vitePkg = requireFrom(join(clientDir, 'package.json'), 'vite/package.json');
  const esbuildHref = requireFrom(vitePkg, 'esbuild');
  const { build } = await import(esbuildHref);
  await build({
    entryPoints: [runSource],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: bundleOut,
    external: ['spacetimedb'],
    logLevel: 'silent',
  });
}

function findStandalonePid() {
  try {
    const text = execFileSync('ps', ['-eo', 'pid,comm'], { encoding: 'utf8' });
    const row = text.split('\n').find((line) => line.includes('spacetimedb-sta'));
    if (!row) return null;
    return Number(row.trim().split(/\s+/)[0]);
  } catch {
    return null;
  }
}

function readProc(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const ticks = Number(rest[11]) + Number(rest[12]);
  const status = readFileSync(`/proc/${pid}/status`, 'utf8');
  const rssKb = Number((/VmRSS:\s+(\d+)/.exec(status) || [])[1] || 0);
  return { ticks, rssKb, atMs: Date.now() };
}

function clkTick() {
  try {
    return Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim()) || 100;
  } catch {
    return 100;
  }
}

function parseBotLine(line, tag) {
  if (!line.startsWith(`${tag} `)) return null;
  try {
    return JSON.parse(line.slice(tag.length + 1));
  } catch {
    return null;
  }
}

function takeBotLine(line, state) {
  if (line.length === 0) return;
  state.lines.push(line);
  const parsed = parseBotLine(line, 'KAEDE_LOAD_RESULT');
  if (parsed) state.result = parsed;
  const err = parseBotLine(line, 'KAEDE_LOAD_ERROR');
  if (err) state.error = err;
}

function startBots() {
  const child = spawn(
    process.execPath,
    [
      bundleOut,
      '--count',
      String(count),
      '--movers',
      String(movers),
      '--seconds',
      String(seconds + 8),
      '--stagger-ms',
      String(staggerMs),
    ],
    { cwd: clientDir, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const state = { lines: [], result: null, error: null };
  child.stdout.on('data', (buf) => {
    for (const line of buf.toString().split('\n')) takeBotLine(line, state);
  });
  child.stderr.on('data', (buf) => process.stderr.write(buf));
  return {
    child,
    getResult: () => state.result,
    getError: () => state.error,
    stop: () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    },
  };
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

function mean(values) {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function ext(values) {
  if (values.length === 0) return { min: 0, max: 0 };
  return { min: Math.min(...values), max: Math.max(...values) };
}

async function webglRenderer(page) {
  return page.evaluate(() => {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl');
    if (!gl) return 'none';
    const extInfo = gl.getExtension('WEBGL_debug_renderer_info');
    if (!extInfo) return 'webgl';
    return gl.getParameter(extInfo.UNMASKED_RENDERER_WEBGL);
  });
}

async function sampleObserver(page) {
  return page.evaluate(() => {
    const snap = window.__kaedeE2E?.snapshot();
    const net = window.__kaedeE2ENet;
    if (!snap) return null;
    const xs = snap.remotePlayers.map((p) => p.x);
    return {
      tick: snap.tick,
      fps: snap.fps,
      remotes: snap.remotePlayers.length,
      playerRowUpdates: net?.playerRowUpdates ?? 0,
      minX: xs.length === 0 ? 0 : Math.min(...xs),
      maxX: xs.length === 0 ? 0 : Math.max(...xs),
    };
  });
}

async function openObserver() {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: artifactsDir, size: { width: 1280, height: 720 } },
  });
  const page = await context.newPage();
  await page.goto(`${target.replace(/\/$/, '')}/?perf=1`);
  await page.waitForFunction(() => (window.__kaedeE2E?.snapshot().tick ?? -1) >= 0, undefined, {
    timeout: 60_000,
  });
  return { browser, context, page, renderer: await webglRenderer(page) };
}

function throwIfBotError(bots) {
  const err = bots.getError();
  if (!err) return;
  throw new Error(`bot error: ${err.message}`);
}

async function waitUntilRemotes(page, bots, want) {
  const joinDeadline = Date.now() + 120_000;
  while (Date.now() < joinDeadline) {
    const snap = await sampleObserver(page);
    if (snap && snap.remotes >= want) return snap;
    throwIfBotError(bots);
    await page.waitForTimeout(250);
  }
  return sampleObserver(page);
}

function requireJoined(snap, want, bots, browser) {
  if (snap && snap.remotes >= want) return snap;
  bots.stop();
  void browser.close();
  throw new Error(`observer saw ${snap?.remotes ?? 0} remotes after join window, expected ${want}`);
}

function rateDelta(curr, prev, dt) {
  if (dt <= 0) return 0;
  return (curr - prev) / dt;
}

function pushRss(rssSamples, pid) {
  if (pid === null) return;
  rssSamples.push(readProc(pid).rssKb);
}

function recordSample(samples, rssSamples, pid, t0, last, snap, now) {
  samples.push({
    t: now - t0,
    fps: snap.fps,
    remotes: snap.remotes,
    updateRate: rateDelta(snap.playerRowUpdates, last.updates, (now - last.at) / 1000),
    spread: snap.maxX - snap.minX,
  });
  pushRss(rssSamples, pid);
  return { updates: snap.playerRowUpdates, at: now };
}

async function collectSamples(page, pid, durationSec, seedUpdates) {
  const samples = [];
  const rssSamples = [];
  const t0 = Date.now();
  let last = { updates: seedUpdates, at: t0 };
  while (Date.now() - t0 < durationSec * 1000) {
    await page.waitForTimeout(500);
    const snap = await sampleObserver(page);
    if (!snap) continue;
    last = recordSample(samples, rssSamples, pid, t0, last, snap, Date.now());
  }
  return { samples, rssSamples, procEnd: pid === null ? null : readProc(pid) };
}

function waitForBotExit(bots) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), 20_000);
    if (bots.child.exitCode !== null) {
      clearTimeout(timeout);
      resolve(true);
      return;
    }
    bots.child.once('exit', () => {
      clearTimeout(timeout);
      resolve(true);
    });
  });
}

async function closeObserver(context, browser, page, bots) {
  const botFinished = await waitForBotExit(bots);
  if (!botFinished) bots.stop();
  const botResult = bots.getResult();
  const video = page.video();
  await context.close();
  await browser.close();
  return { botResult, videoPath: video ? await video.path() : null };
}

function cpuOf(procStart, procEnd, ticksPerSec) {
  if (!procStart || !procEnd) return { wallSec: 0, cpuSec: 0, percent: 0 };
  const wallSec = Math.max(0.001, (procEnd.atMs - procStart.atMs) / 1000);
  const cpuSec = (procEnd.ticks - procStart.ticks) / ticksPerSec;
  return { wallSec, cpuSec, percent: (cpuSec / wallSec) * 100 };
}

function observerStats(samples) {
  const fps = samples.map((s) => s.fps).filter((n) => n > 0);
  const updateRates = samples.map((s) => s.updateRate);
  const spreads = samples.map((s) => s.spread);
  const remotes = samples.map((s) => s.remotes);
  const fpsExt = ext(fps);
  const remoteExt = ext(remotes);
  const rateExt = ext(updateRates);
  const spreadExt = ext(spreads);
  return {
    samples: samples.length,
    remotes: { mean: mean(remotes), min: remoteExt.min, max: remoteExt.max },
    fps: {
      mean: mean(fps),
      p50: percentile(fps, 50),
      p95: percentile(fps, 95),
      min: fpsExt.min,
      max: fpsExt.max,
    },
    playerRowUpdatesPerSec: {
      mean: mean(updateRates),
      p50: percentile(updateRates, 50),
      max: rateExt.max,
    },
    xSpreadPx: { mean: mean(spreads), max: spreadExt.max },
  };
}

function hostStats(pid, procStart, cpu, rssSamples) {
  const rssExt = ext(rssSamples);
  return {
    pid,
    cpuCorePercent: cpu.percent,
    cpuSeconds: cpu.cpuSec,
    rssKb: { start: procStart?.rssKb ?? 0, mean: mean(rssSamples), max: rssExt.max },
  };
}

function writeReport(report) {
  writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

async function main() {
  mkdirSync(artifactsDir, { recursive: true });
  await bundleBots();
  const pid = findStandalonePid();
  const procStart = pid === null ? null : readProc(pid);
  const session = await openObserver();
  const bots = startBots();
  const joinedSnap = requireJoined(
    await waitUntilRemotes(session.page, bots, count),
    count,
    bots,
    session.browser,
  );
  const collected = await collectSamples(session.page, pid, seconds, joinedSnap.playerRowUpdates);
  const screenshotPath = join(artifactsDir, `load_${label}_observer.png`);
  await session.page.screenshot({ path: screenshotPath, fullPage: false });
  const closed = await closeObserver(session.context, session.browser, session.page, bots);
  const cpu = cpuOf(procStart, collected.procEnd, clkTick());
  writeReport({
    at: new Date().toISOString(),
    target,
    count,
    movers,
    seconds,
    renderer: session.renderer,
    artifacts: { screenshot: screenshotPath, video: closed.videoPath },
    observer: observerStats(collected.samples),
    host: hostStats(pid, procStart, cpu, collected.rssSamples),
    bots: closed.botResult,
  });
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
