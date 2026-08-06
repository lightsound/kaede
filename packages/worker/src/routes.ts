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

function meetingSegment(
  method: string,
  pathname: string,
  want: string,
  suffix: string,
): string | undefined {
  if (method !== want) return undefined;
  const match = new RegExp(`^/calls/meetings/([^/]+)/${suffix}$`).exec(pathname);
  const id = match?.[1];
  return id !== undefined && isMeetingIdLike(id) ? id : undefined;
}

function recordingSegment(
  method: string,
  pathname: string,
  want: string,
  suffix: string,
): string | undefined {
  if (method !== want) return undefined;
  const match = new RegExp(`^/calls/recordings/([^/]+)/${suffix}$`).exec(pathname);
  const id = match?.[1];
  return id !== undefined && isRecordingIdLike(id) ? id : undefined;
}

/** Resolves one call-API route, or undefined when this Worker does not serve it. */
export function matchCallRoute(method: string, pathname: string): CallRoute | undefined {
  if (method === 'POST' && pathname === '/webhooks/realtimekit') return { kind: 'webhook' };
  if (method === 'POST' && pathname === '/calls/meetings') return { kind: 'provision' };
  const mintId = meetingSegment(method, pathname, 'POST', 'participants');
  if (mintId !== undefined) return { kind: 'mint', meetingId: mintId };
  const startId = meetingSegment(method, pathname, 'POST', 'recordings');
  if (startId !== undefined) return { kind: 'startRecording', meetingId: startId };
  const stopId = recordingSegment(method, pathname, 'POST', 'stop');
  if (stopId !== undefined) return { kind: 'stopRecording', recordingId: stopId };
  const downloadId = recordingSegment(method, pathname, 'GET', 'download');
  if (downloadId !== undefined) return { kind: 'downloadRecording', recordingId: downloadId };
  return undefined;
}
