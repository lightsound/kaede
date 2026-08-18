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

function startBot(
  id: number,
  conn: DbConnection,
  identity: Identity,
  walks: boolean,
  start: { tick: number; x: number },
): LiveBot {
  const metrics: BotMetrics = {
    id,
    joined: true,
    batchesSent: 0,
    resends: 0,
    acks: 0,
    ackLatencyMs: [],
    remoteUpdates: 0,
    lastX: start.x,
    stalled: false,
  };
  const hex = identity.toHexString();
  let lastAcked = start.tick;
  let x = start.x;
  let dir: number = id % 2 === 0 ? RIGHT : LEFT;
  let inFlight: { startTick: number; inputs: Uint8Array; sentAt: number } | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  const send = (startTick: number, inputs: Uint8Array, resend: boolean): void => {
    inFlight = { startTick, inputs, sentAt: Date.now() };
    if (resend) metrics.resends += 1;
    else metrics.batchesSent += 1;
    conn.reducers.submitInputs({ startTick, inputs }).catch(() => {});
  };

  conn.db.player.onUpdate((_ctx, _old, row) => {
    const rowHex = row.identity.toHexString();
    if (rowHex !== hex) {
      metrics.remoteUpdates += 1;
      return;
    }
    lastAcked = row.tick;
    x = row.x;
    metrics.lastX = x;
    if (inFlight && row.tick >= inFlight.startTick + inFlight.inputs.length) {
      metrics.acks += 1;
      metrics.ackLatencyMs.push(Date.now() - inFlight.sentAt);
      inFlight = undefined;
    }
  });

  if (walks) {
    timer = setInterval(() => {
      const now = Date.now();
      if (inFlight) {
        if (now - inFlight.sentAt >= RESEND_TIMEOUT_MS) {
          send(inFlight.startTick, inFlight.inputs, true);
        }
        if (now - inFlight.sentAt >= RESEND_TIMEOUT_MS * 4) metrics.stalled = true;
        return;
      }
      if (x >= WORLD_WIDTH - EDGE) dir = LEFT;
      else if (x <= EDGE) dir = RIGHT;
      const inputs = new Uint8Array(TICKS_PER_FLUSH).fill(dir);
      const startTick = lastAcked;
      send(startTick, inputs, false);
    }, INPUT_FLUSH_INTERVAL_MS);
  }

  return {
    conn,
    metrics,
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

function summarize(bots: LiveBot[], elapsedMs: number): unknown {
  const metrics = bots.map((b) => b.metrics);
  const latencies = metrics.flatMap((m) => m.ackLatencyMs).sort((a, b) => a - b);
  const joined = metrics.filter((m) => m.joined).length;
  const stalled = metrics.filter((m) => m.stalled).length;
  const batches = metrics.reduce((n, m) => n + m.batchesSent, 0);
  const acks = metrics.reduce((n, m) => n + m.acks, 0);
  const resends = metrics.reduce((n, m) => n + m.resends, 0);
  const remoteUpdates = metrics.reduce((n, m) => n + m.remoteUpdates, 0);
  const xs = metrics.map((m) => m.lastX);
  const spread = xs.length === 0 ? 0 : Math.max(...xs) - Math.min(...xs);
  const sec = elapsedMs / 1000;
  return {
    bots: metrics.length,
    joined,
    stalled,
    batches,
    acks,
    resends,
    batchesPerBotPerSec: joined === 0 || sec === 0 ? 0 : batches / joined / sec,
    acksPerBotPerSec: joined === 0 || sec === 0 ? 0 : acks / joined / sec,
    remoteUpdatesPerBotPerSec: joined === 0 || sec === 0 ? 0 : remoteUpdates / joined / sec,
    ackLatencyMs: {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
      max: latencies[latencies.length - 1] ?? 0,
      n: latencies.length,
    },
    xSpreadPx: spread,
    elapsedMs,
  };
}

async function main(): Promise<void> {
  const opts = parseArgs(nodeProc().argv.slice(2));
  const bots: LiveBot[] = [];
  const t0 = Date.now();
  emit('KAEDE_LOAD_START', opts);
  try {
    for (let i = 0; i < opts.count; i++) {
      const walks = i < opts.movers;
      const bot = await spawnBot(i, walks, opts.uri, opts.db);
      bots.push(bot);
      if (opts.staggerMs > 0) await sleep(opts.staggerMs);
    }
    emit('KAEDE_LOAD_JOINED', { joined: bots.length, ms: Date.now() - t0 });
    const deadline = Date.now() + opts.seconds * 1000;
    while (Date.now() < deadline) {
      await sleep(1000);
      emit('KAEDE_LOAD_PROGRESS', summarize(bots, Date.now() - t0));
    }
  } finally {
    const result = summarize(bots, Date.now() - t0);
    for (const bot of bots) bot.stop();
    emit('KAEDE_LOAD_RESULT', result);
  }
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  emit('KAEDE_LOAD_ERROR', { message });
  nodeProc().exit(1);
});
