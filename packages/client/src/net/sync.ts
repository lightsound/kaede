import { INTERP_DELAY_MS, SNAPSHOT_SEND_INTERVAL_MS, type Facing } from '@maple/shared';
import type { GameApp } from '../game/GameApp';
import type { DbConnection } from '../module_bindings';
import { connect } from './connection';

/** One timestamped position sample for a remote player. */
interface Snapshot {
  t: number;
  x: number;
  y: number;
  facing: Facing;
}

/** Discard samples older than this, but always keep the last two to interpolate. */
const SNAPSHOT_TTL_MS = 1500;

const toFacing = (f: number): Facing => (f < 0 ? -1 : 1);

export interface Net {
  dispose(): void;
}

/**
 * Wires the game to SpacetimeDB: publishes the local player's state at a fixed
 * rate and renders interpolated remote players. Returns immediately; the
 * connection is established asynchronously.
 */
export function startNet(gameApp: GameApp): Net {
  const buffers = new Map<string, Snapshot[]>();
  const names = new Map<string, string>();
  let conn: DbConnection | undefined;
  let myIdHex = '';
  let namedSelf = false;
  let lastSendMs = 0;
  let disposed = false;

  // Outbound: throttle to one publish per SNAPSHOT_SEND_INTERVAL_MS while connected.
  gameApp.onLocalTick((s) => {
    if (!conn) return;
    const now = performance.now();
    if (now - lastSendMs < SNAPSHOT_SEND_INTERVAL_MS) return;
    lastSendMs = now;
    conn.reducers
      .updatePosition({ x: s.x, y: s.y, vx: s.vx, vy: s.vy, facing: s.facing })
      .catch(() => {});
  });

  // Inbound: buffer a timestamped snapshot for each remote row change.
  const record = (idHex: string, x: number, y: number, facing: number) => {
    let buf = buffers.get(idHex);
    if (!buf) {
      buf = [];
      buffers.set(idHex, buf);
    }
    buf.push({ t: performance.now(), x, y, facing: toFacing(facing) });
  };

  const handle = (idHex: string, name: string, x: number, y: number, facing: number) => {
    if (idHex === myIdHex) {
      if (!namedSelf) {
        gameApp.setLocalPlayerName(name);
        namedSelf = true;
      }
      return;
    }
    names.set(idHex, name);
    record(idHex, x, y, facing);
  };

  connect()
    .then(({ conn: c, myIdHex: id }) => {
      if (disposed) {
        c.disconnect();
        return;
      }
      conn = c;
      myIdHex = id;

      // Seed from rows already in the cache. myIdHex must be set before this
      // runs, or our own row would be buffered as a frozen remote ghost.
      // This is also what names the local player.
      for (const row of c.db.player.iter()) {
        handle(row.identity.toHexString(), row.name, row.x, row.y, row.facing);
      }

      c.db.player.onInsert((_ctx, row) =>
        handle(row.identity.toHexString(), row.name, row.x, row.y, row.facing),
      );
      c.db.player.onUpdate((_ctx, _old, row) =>
        handle(row.identity.toHexString(), row.name, row.x, row.y, row.facing),
      );
      c.db.player.onDelete((_ctx, row) => {
        const idHex = row.identity.toHexString();
        if (idHex === myIdHex) return;
        buffers.delete(idHex);
        names.delete(idHex);
        gameApp.removeRemotePlayer(idHex);
      });
    })
    .catch(() => {});

  // Render remote players interpolated INTERP_DELAY_MS in the past.
  gameApp.onFrame((now) => {
    const renderTime = now - INTERP_DELAY_MS;
    for (const [idHex, buf] of buffers) {
      prune(buf, now);
      if (buf.length === 0) continue;
      const s = sampleAt(buf, renderTime);
      gameApp.upsertRemotePlayer(idHex, names.get(idHex) ?? '', s.x, s.y, s.facing);
    }
  });

  return {
    dispose() {
      disposed = true;
      conn?.disconnect();
      conn = undefined;
    },
  };
}

/** Drop samples older than the TTL, always keeping at least the last two. */
function prune(buf: Snapshot[], now: number): void {
  while (buf.length > 2 && now - buf[0].t > SNAPSHOT_TTL_MS) buf.shift();
}

/**
 * Returns the position at renderTime by linearly interpolating between the two
 * straddling snapshots. Clamps to the nearest snapshot outside the buffered
 * range (no extrapolation). facing comes from the later snapshot.
 */
function sampleAt(buf: Snapshot[], renderTime: number): Snapshot {
  if (renderTime <= buf[0].t) return buf[0];
  const last = buf[buf.length - 1];
  if (renderTime >= last.t) return last;
  for (let i = 1; i < buf.length; i++) {
    const b = buf[i];
    if (renderTime <= b.t) {
      const a = buf[i - 1];
      const span = b.t - a.t;
      const alpha = span > 0 ? (renderTime - a.t) / span : 0;
      return {
        t: renderTime,
        x: a.x + (b.x - a.x) * alpha,
        y: a.y + (b.y - a.y) * alpha,
        facing: b.facing,
      };
    }
  }
  return last;
}
