// fallow-ignore-file coverage-gaps -- path matchers exercised through routeCallRequest in rules.test.ts (same pure surface; kept in this file so routeCallRequest stays under the CRAP budget)
// Pure path matchers for the call API — kept tiny so routeCallRequest's
// composition stays under the CRAP budget (unit-tested via rules.test.ts).
import { isMeetingIdLike, isRecordingIdLike } from '@kaede/shared';

/**
 * What one request asks of the call API (see rules.ts header for the
 * provision / mint / recording / webhook meanings).
 */
export type CallRoute =
  | { kind: 'provision' }
  | { kind: 'mint'; meetingId: string }
  | { kind: 'startRecording'; meetingId: string }
  | { kind: 'stopRecording'; recordingId: string }
  | { kind: 'downloadRecording'; recordingId: string }
  | { kind: 'webhook' };

/**
 * Extracts a single path segment between `prefix` and `suffix` without
 * RegExp (fallow security flags dynamic RegExp as a ReDoS candidate; the
 * segment is then vetted by `accept`).
 */
function vettedSegment(
  method: string,
  pathname: string,
  want: string,
  prefix: string,
  suffix: string,
  accept: (id: string) => boolean,
): string | undefined {
  if (method !== want) return undefined;
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) return undefined;
  const id = pathname.slice(prefix.length, pathname.length - suffix.length);
  if (id === '' || id.includes('/')) return undefined;
  return accept(id) ? id : undefined;
}

type SegmentRoute = Exclude<CallRoute, { kind: 'provision' } | { kind: 'webhook' }>;

/** One path pattern → CallRoute builder (table keeps matchCallRoute under CRAP / clone budget). */
const SEGMENT_ROUTES: ReadonlyArray<{
  method: string;
  prefix: string;
  suffix: string;
  accept: (id: string) => boolean;
  toRoute: (id: string) => SegmentRoute;
}> = [
  {
    method: 'POST',
    prefix: '/calls/meetings/',
    suffix: '/participants',
    accept: isMeetingIdLike,
    toRoute: (id) => ({ kind: 'mint', meetingId: id }),
  },
  {
    method: 'POST',
    prefix: '/calls/meetings/',
    suffix: '/recordings',
    accept: isMeetingIdLike,
    toRoute: (id) => ({ kind: 'startRecording', meetingId: id }),
  },
  {
    method: 'POST',
    prefix: '/calls/recordings/',
    suffix: '/stop',
    accept: isRecordingIdLike,
    toRoute: (id) => ({ kind: 'stopRecording', recordingId: id }),
  },
  {
    method: 'GET',
    prefix: '/calls/recordings/',
    suffix: '/download',
    accept: isRecordingIdLike,
    toRoute: (id) => ({ kind: 'downloadRecording', recordingId: id }),
  },
];

/** Resolves one call-API route, or undefined when this Worker does not serve it. */
export function matchCallRoute(method: string, pathname: string): CallRoute | undefined {
  if (method === 'POST' && pathname === '/webhooks/realtimekit') return { kind: 'webhook' };
  if (method === 'POST' && pathname === '/calls/meetings') return { kind: 'provision' };
  for (const entry of SEGMENT_ROUTES) {
    const id = vettedSegment(
      method,
      pathname,
      entry.method,
      entry.prefix,
      entry.suffix,
      entry.accept,
    );
    if (id !== undefined) return entry.toRoute(id);
  }
  return undefined;
}
