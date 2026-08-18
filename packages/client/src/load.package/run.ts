// fallow-ignore-file coverage-gaps -- hand-run load probe against a live SpacetimeDB host; not part of the app or unit coverage
// fallow-ignore-file unused-file -- run via packages/e2e/measure-concurrent-movers.mjs (esbuild bundle), never imported
/**
 * Headless guest movers for the concurrent-character load probe.
 *
 * Each bot opens a real SpacetimeDB WebSocket, joins as a guest, subscribes
 * to the default-map player rows (the same AoI query a browser uses), and
 * optionally walks at the production flush cadence (24 ticks / 400ms).
 *
 * Usage (via the e2e measure script, which bundles this file):
 *   --count 50 --movers 50 --seconds 20
 */
import {
  DEFAULT_MAP_ID,
  INPUT_FLUSH_INTERVAL_MS,
  packInput,
  RESEND_TIMEOUT_MS,
  TICK_RATE,
  WORLD_WIDTH,
} from '@kaede/shared';
import type { Identity } from 'spacetimedb';
import { DbConnection, tables } from '../module_bindings';

const TICKS_PER_FLUSH = Math.round((TICK_RATE * INPUT_FLUSH_INTERVAL_MS) / 1000);
const LEFT = packInput({ left: true, right: false, jump: false, up: false, down: false });
const RIGHT = packInput({ left: false, right: true, jump: false, up: false, down: false });
const EDGE = 80;

interface NodeProc {
  argv: string[];
  exit(code: number): void;
  on(event: string, listener: () => void): void;
  stdout: { write(s: string): void };
}

function nodeProc(): NodeProc {
  return (globalThis as unknown as { process: NodeProc }).process;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function argValue(args: string[], name: string, fallback: string): string {
  const i = args.indexOf(name);
  if (i < 0 || i + 1 >= args.length) return fallback;
  return args[i + 1] ?? fallback;
}

function parseArgs(argv: string[]): {
  count: number;
  movers: number;
  uri: string;
  db: string;
  seconds: number;
  staggerMs: number;
} {
  const count = Number(argValue(argv, '--count', '20'));
  const moversRaw = argValue(argv, '--movers', String(count));
  return {
    count,
    movers: Number(moversRaw),
    uri: argValue(argv, '--uri', 'ws://localhost:3000'),
    db: argValue(argv, '--db', 'kaede'),
    seconds: Number(argValue(argv, '--seconds', '20')),
    staggerMs: Number(argValue(argv, '--stagger-ms', '40')),
  };
}

function emit(tag: string, payload: unknown): void {
  nodeProc().stdout.write(`${tag} ${JSON.stringify(payload)}\n`);
}

interface BotMetrics {
  id: number;
  joined: boolean;
  batchesSent: number;
  resends: number;
  acks: number;
  ackLatencyMs: number[];
  remoteUpdates: number;
  lastX: number;
  stalled: boolean;
}

interface InFlight {
  startTick: number;
  inputs: Uint8Array;
  sentAt: number;
  firstSentAt: number;
}

interface Walker {
  conn: DbConnection;
  metrics: BotMetrics;
  lastAcked: number;
  x: number;
  dir: number;
  inFlight: InFlight | undefined;
}

interface LiveBot {
  conn: DbConnection;
  metrics: BotMetrics;
  stop(): void;
}

function connectGuest(
  uri: string,
  db: string,
): Promise<{ conn: DbConnection; identity: Identity }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };
    DbConnection.builder()
      .withUri(uri)
      .withDatabaseName(db)
      .onConnect((conn, identity) => {
        conn
          .subscriptionBuilder()
          .onApplied(() => finish(() => resolve({ conn, identity })))
          .subscribe([
            tables.player.where((p) => p.identity.eq(identity)),
            tables.player.where((p) => p.mapId.eq(DEFAULT_MAP_ID)),
          ]);
      })
      .onConnectError((_ctx, err) => finish(() => reject(err)))
      .onDisconnect(() => {
        finish(() => reject(new Error('disconnected before subscribe applied')));
      })
      .build();
  });
}

async function waitForOwnRow(
  conn: DbConnection,
  identity: Identity,
  timeoutMs: number,
): Promise<{ tick: number; x: number }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = conn.db.player.identity.find(identity);
    if (row) return { tick: row.tick, x: row.x };
    await sleep(20);
  }
  throw new Error('own player row did not appear after join');
}

function firstSentAtOf(inFlight: InFlight | undefined, resend: boolean, now: number): number {
  if (resend && inFlight) return inFlight.firstSentAt;
  return now;
}

function noteSend(walker: Walker, startTick: number, inputs: Uint8Array, resend: boolean): void {
  const now = Date.now();
  walker.inFlight = {
    startTick,
    inputs,
    sentAt: now,
    firstSentAt: firstSentAtOf(walker.inFlight, resend, now),
  };
  if (resend) walker.metrics.resends += 1;
  else walker.metrics.batchesSent += 1;
  walker.conn.reducers.submitInputs({ startTick, inputs }).catch(() => {});
}

function patrolDir(x: number, dir: number): number {
  if (x >= WORLD_WIDTH - EDGE) return LEFT;
  if (x <= EDGE) return RIGHT;
  return dir;
}

function tickInFlight(walker: Walker, now: number): void {
  const flight = walker.inFlight;
  if (!flight) return;
  if (now - flight.sentAt >= RESEND_TIMEOUT_MS) {
    noteSend(walker, flight.startTick, flight.inputs, true);
  }
  if (now - flight.firstSentAt >= RESEND_TIMEOUT_MS * 4) walker.metrics.stalled = true;
}

function tickPatrol(walker: Walker): void {
  const now = Date.now();
  if (walker.inFlight) {
    tickInFlight(walker, now);
    return;
  }
  walker.dir = patrolDir(walker.x, walker.dir);
  noteSend(walker, walker.lastAcked, new Uint8Array(TICKS_PER_FLUSH).fill(walker.dir), false);
}

function applyOwnRow(walker: Walker, tick: number, x: number): void {
  walker.lastAcked = tick;
  walker.x = x;
  walker.metrics.lastX = x;
  const flight = walker.inFlight;
  if (!flight || tick < flight.startTick + flight.inputs.length) return;
  walker.metrics.acks += 1;
  walker.metrics.ackLatencyMs.push(Date.now() - flight.firstSentAt);
  walker.inFlight = undefined;
}

function onPlayerUpdate(
  walker: Walker,
  ownHex: string,
  rowHex: string,
  tick: number,
  x: number,
): void {
  if (rowHex !== ownHex) {
    walker.metrics.remoteUpdates += 1;
    return;
  }
  applyOwnRow(walker, tick, x);
}

function startBot(
  id: number,
  conn: DbConnection,
  identity: Identity,
  walks: boolean,
  start: { tick: number; x: number },
): LiveBot {
  const walker: Walker = {
    conn,
    metrics: {
      id,
      joined: true,
      batchesSent: 0,
      resends: 0,
      acks: 0,
      ackLatencyMs: [],
      remoteUpdates: 0,
      lastX: start.x,
      stalled: false,
    },
    lastAcked: start.tick,
    x: start.x,
    dir: id % 2 === 0 ? RIGHT : LEFT,
    inFlight: undefined,
  };
  const ownHex = identity.toHexString();
  let timer: ReturnType<typeof setInterval> | undefined;

  conn.db.player.onUpdate((_ctx, _old, row) => {
    onPlayerUpdate(walker, ownHex, row.identity.toHexString(), row.tick, row.x);
  });

  if (walks) {
    timer = setInterval(() => tickPatrol(walker), INPUT_FLUSH_INTERVAL_MS);
  }

  return {
    conn,
    metrics: walker.metrics,
    stop() {
      if (timer !== undefined) clearInterval(timer);
      conn.disconnect();
    },
  };
}

async function spawnBot(id: number, walks: boolean, uri: string, db: string): Promise<LiveBot> {
  const { conn, identity } = await connectGuest(uri, db);
  await conn.reducers.join({});
  const start = await waitForOwnRow(conn, identity, 10_000);
  return startBot(id, conn, identity, walks, start);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i] ?? 0;
}

function sumBy(metrics: BotMetrics[], pick: (m: BotMetrics) => number): number {
  return metrics.reduce((n, m) => n + pick(m), 0);
}

function perBotPerSec(n: number, joined: number, sec: number): number {
  if (joined === 0 || sec === 0) return 0;
  return n / joined / sec;
}

function xSpread(xs: number[]): number {
  if (xs.length === 0) return 0;
  return Math.max(...xs) - Math.min(...xs);
}

function latencySummary(latencies: number[]): {
  p50: number;
  p95: number;
  p99: number;
  max: number;
  n: number;
} {
  return {
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    max: latencies[latencies.length - 1] ?? 0,
    n: latencies.length,
  };
}

function summarize(bots: LiveBot[], elapsedMs: number): unknown {
  const metrics = bots.map((b) => b.metrics);
  const latencies = metrics.flatMap((m) => m.ackLatencyMs).sort((a, b) => a - b);
  const joined = metrics.filter((m) => m.joined).length;
  const sec = elapsedMs / 1000;
  const batches = sumBy(metrics, (m) => m.batchesSent);
  const acks = sumBy(metrics, (m) => m.acks);
  const resends = sumBy(metrics, (m) => m.resends);
  const remoteUpdates = sumBy(metrics, (m) => m.remoteUpdates);
  return {
    bots: metrics.length,
    joined,
    stalled: metrics.filter((m) => m.stalled).length,
    batches,
    acks,
    resends,
    batchesPerBotPerSec: perBotPerSec(batches, joined, sec),
    acksPerBotPerSec: perBotPerSec(acks, joined, sec),
    remoteUpdatesPerBotPerSec: perBotPerSec(remoteUpdates, joined, sec),
    ackLatencyMs: latencySummary(latencies),
    xSpreadPx: xSpread(metrics.map((m) => m.lastX)),
    elapsedMs,
  };
}

async function spawnAll(bots: LiveBot[], opts: ReturnType<typeof parseArgs>): Promise<void> {
  for (let i = 0; i < opts.count; i++) {
    bots.push(await spawnBot(i, i < opts.movers, opts.uri, opts.db));
    await sleep(opts.staggerMs);
  }
}

async function runUntil(bots: LiveBot[], seconds: number, tWalk: number): Promise<void> {
  const deadline = tWalk + seconds * 1000;
  while (Date.now() < deadline) {
    await sleep(1000);
    emit('KAEDE_LOAD_PROGRESS', summarize(bots, Date.now() - tWalk));
  }
}

function stopAll(bots: LiveBot[]): void {
  for (const bot of bots) bot.stop();
}

async function main(): Promise<void> {
  const opts = parseArgs(nodeProc().argv.slice(2));
  emit('KAEDE_LOAD_START', opts);
  const bots: LiveBot[] = [];
  let tWalk = Date.now();
  try {
    await spawnAll(bots, opts);
    tWalk = Date.now();
    emit('KAEDE_LOAD_JOINED', { joined: bots.length });
    await runUntil(bots, opts.seconds, tWalk);
  } finally {
    emit('KAEDE_LOAD_RESULT', summarize(bots, Date.now() - tWalk));
    stopAll(bots);
  }
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  emit('KAEDE_LOAD_ERROR', { message });
  nodeProc().exit(1);
});
