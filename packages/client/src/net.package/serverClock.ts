/**
 * Estimates the mapping between the server clock (row.updatedAt) and the local
 * render clock (performance.now) from observed (serverMs, localMs) pairs.
 *
 * Each pair measures `localMs - serverMs` = clock offset + that update's
 * delivery delay. Taking the minimum over a sliding window approximates the
 * fastest observed path, so delivery jitter never jitters the estimated
 * timeline — a slow packet just measures a larger (ignored) offset. Two
 * rotating buckets keep the window bounded (between WINDOW_MS and 2x that)
 * while still adapting to clock drift and route changes.
 */

/** Rotation period of the min-offset buckets (ms). */
const WINDOW_MS = 10_000;

export interface ServerClock {
  /** Feed one observed pair: a row's server timestamp and its local receive time. */
  record(serverMs: number, localMs: number): void;
  /** The current moment on the server timeline, or undefined before any sample. */
  serverNow(localMs: number): number | undefined;
}

export function createServerClock(): ServerClock {
  let currMin = Infinity;
  let prevMin = Infinity;
  let bucketStart: number | undefined;

  return {
    record(serverMs, localMs) {
      if (bucketStart === undefined) bucketStart = localMs;
      if (localMs - bucketStart > WINDOW_MS) {
        prevMin = currMin;
        currMin = Infinity;
        bucketStart = localMs;
      }
      currMin = Math.min(currMin, localMs - serverMs);
    },
    serverNow(localMs) {
      const offset = Math.min(currMin, prevMin);
      return offset === Infinity ? undefined : localMs - offset;
    },
  };
}
