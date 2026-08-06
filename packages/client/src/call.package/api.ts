// fallow-ignore-file coverage-gaps -- thin fetch wrappers over the call API Worker (packages/worker); they need the live Worker, not a unit test. The flow that orchestrates them is flow.ts, unit-tested with these injected
import { type AuthTokenGetter, storedSessionToken } from '../net.package';

// The call API Worker (packages/worker, deployed as kaede-call by
// infra/alchemy.run.ts). The production default is the Worker's stable
// workers.dev URL — a deterministic name, so the client needs no
// deploy-time wiring; local dev talks to `wrangler dev` on its default
// port (README「通話 API Worker」), and VITE_CALL_API_URL overrides both.
const BASE_URL =
  import.meta.env.VITE_CALL_API_URL ??
  (import.meta.env.PROD ? 'https://kaede-call.kaede-751.workers.dev' : 'http://localhost:8787');

/**
 * One authenticated request to the Worker. The bearer credential is the
 * same identity the SpacetimeDB connection speaks under: a member's getter
 * mints a fresh Clerk JWT per request (short-lived — the never-cache
 * rule); a guest's getter yields none, and the request falls back to the
 * connection's stored host-issued token (増分② — the Worker verifies it
 * against the host's public key). Both absent means no connection ever
 * succeeded, which the dock's connected-gate makes unreachable. The
 * recording routes additionally require the MEMBER credential (増分④) —
 * the Worker 403s a guest's, and the UI never offers them to guests.
 */
/** The fetch init of one authenticated JSON request (split for the CRAP budget). */
function requestInit(method: 'GET' | 'POST', token: string, body: unknown): RequestInit {
  return {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

async function callWorker(
  getToken: AuthTokenGetter,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<unknown> {
  const token = (await getToken()) ?? storedSessionToken();
  if (token === undefined) throw new Error('call API: no auth token');
  // fallow-ignore-next-line security-sink -- the host is the build-time BASE_URL constant; the only interpolated segments are a meeting id vetted to UUID shape at the reducer write (isMeetingIdLike) and a recording file name vetted by isRecordingFileNameLike, both re-vetted by the Worker's route
  const response = await fetch(`${BASE_URL}${path}`, requestInit(method, token, body));
  if (!response.ok) throw new Error(`call API: ${path} failed (${response.status})`);
  return response.json();
}

function post(getToken: AuthTokenGetter, path: string, body: unknown): Promise<unknown> {
  return callWorker(getToken, 'POST', path, body);
}

function stringField(payload: unknown, field: string): string {
  const value = (payload as Record<string, unknown> | undefined)?.[field];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`call API: response missing ${field}`);
  }
  return value;
}

/** Asks the Worker to create one meeting; returns its id (the 開始 half). */
export async function provisionMeeting(getToken: AuthTokenGetter): Promise<string> {
  return stringField(await post(getToken, '/calls/meetings', {}), 'meetingId');
}

/**
 * Asks the Worker to mint a participant token for `meetingId` (the 参加
 * half). `name` is what the other participants see on the tile — the
 * caller passes its current display name.
 */
export async function mintCallToken(
  getToken: AuthTokenGetter,
  meetingId: string,
  name: string,
): Promise<string> {
  return stringField(
    await post(getToken, `/calls/meetings/${meetingId}/participants`, { name }),
    'authToken',
  );
}

/**
 * Asks the Worker to start the meeting's cloud recording (増分④ —
 * members only, R2 direct upload). Returns the recording file's basename,
 * fixed at start time by the provider — what the starter logs into the
 * call_recording label row.
 */
export async function startCallRecording(
  getToken: AuthTokenGetter,
  meetingId: string,
): Promise<string> {
  return stringField(
    await post(getToken, `/calls/meetings/${meetingId}/recordings`, {}),
    'fileName',
  );
}

/** Asks the Worker to stop the meeting's active recording (増分④). */
export async function stopCallRecording(
  getToken: AuthTokenGetter,
  meetingId: string,
): Promise<void> {
  await post(getToken, `/calls/meetings/${meetingId}/recordings/stop`, {});
}

/** One finished recording, as the Worker's R2 listing reports it (増分④). */
export interface RecordingFile {
  fileName: string;
  size: number;
  uploadedAt: string;
}

/** The finished recordings in the bucket, newest first (増分④ — members only). */
export async function fetchRecordings(getToken: AuthTokenGetter): Promise<RecordingFile[]> {
  const payload = (await callWorker(getToken, 'GET', '/calls/recordings')) as {
    recordings?: unknown;
  };
  return Array.isArray(payload.recordings) ? (payload.recordings as RecordingFile[]) : [];
}

/** A short-lived presigned URL for one recording — the browser downloads straight from R2. */
export async function fetchRecordingDownloadUrl(
  getToken: AuthTokenGetter,
  fileName: string,
): Promise<string> {
  return stringField(
    await callWorker(getToken, 'GET', `/calls/recordings/${fileName}/download-url`),
    'url',
  );
}
