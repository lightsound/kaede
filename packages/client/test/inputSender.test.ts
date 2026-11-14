import { HEARTBEAT_INTERVAL_MS, mapFor, packInput, type PlayerState } from '@kaede/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { DbConnection } from '../src/module_bindings';
import { createInputSender } from '../src/net.package/inputSender';
import type { OwnSim } from '../src/net.package/playerFeed';
import { fakeConnection } from './fakeDb';

interface SubmitArgs {
  startTick: number;
  inputs: Uint8Array;
}

/** A fake connection whose reducers only record their calls. */
function recordingConn() {
  const submits: SubmitArgs[] = [];
  const portals: { portalId: number }[] = [];
  const conn = fakeConnection({});
  const raw = conn as unknown as { reducers: unknown };
  raw.reducers = {
    submitInputs: (args: SubmitArgs) => {
      submits.push(args);
      return Promise.resolve();
    },
    enterPortal: (args: { portalId: number }) => {
      portals.push(args);
      return Promise.resolve();
    },
  };
  return { conn, submits, portals };
}

/** A prediction stub that records the tick feed and the flushes. */
function recordingPrediction() {
  const ticks: { tick: number; packedInput: number }[] = [];
  const flushes: number[] = [];
  const prediction = {
    onTick: (_state: PlayerState, tick: number, packedInput: number) => {
      ticks.push({ tick, packedInput });
    },
    flushNow: (nowMs: number) => {
      flushes.push(nowMs);
    },
  } as unknown as OwnSim['prediction'];
  return { prediction, ticks, flushes };
}

function harness() {
  let current: DbConnection | undefined;
  const stats: string[] = [];
  const sim: OwnSim = { prediction: undefined, currentMapId: 0, portalPendingAtMs: undefined };
  const sender = createInputSender({
    conn: () => current,
    sim,
    bumpStat: (key) => {
      stats.push(key);
    },
  });
  return {
    sender,
    sim,
    stats,
    setConn: (conn: DbConnection | undefined) => {
      current = conn;
    },
  };
}

const standing = (over: Partial<PlayerState> = {}): PlayerState => ({
  x: 100,
  y: 500,
  vx: 0,
  vy: 0,
  facing: 1,
  onGround: true,
  rope: -1,
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('sendBatch / sendHeartbeat', () => {
  it('sends one batch through the live connection and counts it', () => {
    const { sender, stats, setConn } = harness();
    const { conn, submits } = recordingConn();
    setConn(conn);
    const packed = new Uint8Array([1, 2, 3]);
    sender.sendBatch(7, packed);
    expect(submits).toEqual([{ startTick: 7, inputs: packed }]);
    expect(stats).toEqual(['inputBatchesSent']);
  });

  it('counts a batch even with no live connection (the send itself is skipped)', () => {
    const { sender, stats } = harness();
    sender.sendBatch(7, new Uint8Array([1]));
    expect(stats).toEqual(['inputBatchesSent']);
  });

  it('sends the heartbeat as an empty batch at tick 0 on the given connection', () => {
    const { sender, stats } = harness();
    const { conn, submits } = recordingConn();
    sender.sendHeartbeat(conn);
    expect(submits).toHaveLength(1);
    expect(submits[0]?.startTick).toBe(0);
    expect(submits[0]?.inputs).toHaveLength(0);
    expect(stats).toEqual(['heartbeatsSent']);
  });
});

describe('heartbeatTick', () => {
  it('sends nothing without a connection or without a prediction', () => {
    const { sender, sim, stats, setConn } = harness();
    const { conn, submits } = recordingConn();
    vi.setSystemTime(1_000_000 + HEARTBEAT_INTERVAL_MS * 2);
    sender.heartbeatTick();
    setConn(conn);
    sender.heartbeatTick();
    expect(submits).toEqual([]);
    expect(stats).toEqual([]);
    expect(sim.prediction).toBeUndefined();
  });

  it('sends only once the last send is a full interval old', () => {
    const { sender, sim, stats, setConn } = harness();
    const { conn, submits } = recordingConn();
    const { prediction } = recordingPrediction();
    sim.prediction = prediction;
    setConn(conn);
    // The sender was built at the pinned time, so nothing is due yet.
    sender.heartbeatTick();
    vi.setSystemTime(1_000_000 + HEARTBEAT_INTERVAL_MS - 1);
    sender.heartbeatTick();
    expect(submits).toEqual([]);
    vi.setSystemTime(1_000_000 + HEARTBEAT_INTERVAL_MS);
    sender.heartbeatTick();
    expect(submits).toHaveLength(1);
    expect(stats).toEqual(['heartbeatsSent']);
  });

  it('stays quiet while batches flow: a batch restarts the interval', () => {
    const { sender, sim, setConn } = harness();
    const { conn, submits } = recordingConn();
    const { prediction } = recordingPrediction();
    sim.prediction = prediction;
    setConn(conn);
    vi.setSystemTime(1_000_000 + HEARTBEAT_INTERVAL_MS);
    sender.sendBatch(3, new Uint8Array([9]));
    vi.setSystemTime(1_000_000 + HEARTBEAT_INTERVAL_MS * 2 - 1);
    sender.heartbeatTick();
    expect(submits).toHaveLength(1);
    vi.setSystemTime(1_000_000 + HEARTBEAT_INTERVAL_MS * 2);
    sender.heartbeatTick();
    expect(submits).toHaveLength(2);
  });
});

describe('handleLocalTick', () => {
  it('does nothing but track edges while there is no prediction', () => {
    const { sender, sim, stats } = harness();
    sender.handleLocalTick(standing(), 1, 0);
    sender.handleLocalTick(standing({ onGround: false }), 2, 0);
    expect(stats).toEqual([]);
    // The edge state was still tracked behind the guard: once a
    // prediction exists, the ground-contact edge spanning the
    // prediction-less ticks (airborne at tick 2, grounded now) flushes,
    // and the prediction is fed only from the install on.
    const { prediction, ticks, flushes } = recordingPrediction();
    sim.prediction = prediction;
    sender.handleLocalTick(standing(), 3, 0);
    expect(ticks).toEqual([{ tick: 3, packedInput: 0 }]);
    expect(flushes).toHaveLength(1);
  });

  it('feeds the prediction and flushes on ground-contact edges only', () => {
    const { sender, sim } = harness();
    const { prediction, ticks, flushes } = recordingPrediction();
    sim.prediction = prediction;
    sender.handleLocalTick(standing(), 1, 0);
    sender.handleLocalTick(standing(), 2, 0);
    expect(ticks).toEqual([
      { tick: 1, packedInput: 0 },
      { tick: 2, packedInput: 0 },
    ]);
    // The first tick has no previous ground state, and a steady state is
    // no edge: neither flushes.
    expect(flushes).toEqual([]);
    sender.handleLocalTick(standing({ onGround: false }), 3, 0);
    expect(flushes).toHaveLength(1);
    sender.handleLocalTick(standing(), 4, 0);
    expect(flushes).toHaveLength(2);
  });

  it('fires enter_portal on an up-press inside a portal, then suppresses re-presses while pending', () => {
    const { sender, sim, setConn } = harness();
    const { conn, portals } = recordingConn();
    const { prediction, flushes } = recordingPrediction();
    sim.prediction = prediction;
    setConn(conn);
    const rect = mapFor(0).portals[0].rect;
    const inPortal = standing({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 });
    const up = packInput({ left: false, right: false, jump: false, up: true, down: false });
    sender.handleLocalTick(inPortal, 1, up);
    expect(portals).toEqual([{ portalId: 0 }]);
    // The pending window is flushed first, and the call is marked pending.
    expect(flushes).toHaveLength(1);
    expect(sim.portalPendingAtMs).toBeTypeOf('number');
    // Release and press again inside the pending window: no second call.
    sender.handleLocalTick(inPortal, 2, 0);
    sender.handleLocalTick(inPortal, 3, up);
    expect(portals).toEqual([{ portalId: 0 }]);
  });

  it('does not fire away from a portal or on a held up key', () => {
    const { sender, sim, setConn } = harness();
    const { conn, portals } = recordingConn();
    const { prediction } = recordingPrediction();
    sim.prediction = prediction;
    setConn(conn);
    const up = packInput({ left: false, right: false, jump: false, up: true, down: false });
    sender.handleLocalTick(standing(), 1, up);
    const rect = mapFor(0).portals[0].rect;
    const inPortal = standing({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 });
    // Held from the previous tick (no press edge), even inside the portal.
    sender.handleLocalTick(inPortal, 2, up);
    expect(portals).toEqual([]);
  });
});
