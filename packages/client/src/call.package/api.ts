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
 * One authenticated POST to the Worker. The bearer credential is the same
 * identity the SpacetimeDB connection speaks under: a member's getter
 * mints a fresh Clerk JWT per request (short-lived — the never-cache
 * rule); a guest's getter yields none, and the request falls back to the
 * connection's stored host-issued token (増分② — the Worker verifies it
 * against the host's public key). Both absent means no connection ever
 * succeeded, which the dock's connected-gate makes unreachable.
 */
async function post(getToken: AuthTokenGetter, path: string, body: unknown): Promise<unknown> {
  const token = (await getToken()) ?? storedSessionToken();
  if (token === undefined) throw new Error('call API: no auth token');
  // fallow-ignore-next-line security-sink -- the host is the build-time BASE_URL constant; the only interpolated segment is a meeting id vetted to UUID shape at the reducer write (isMeetingIdLike) and re-vetted by the Worker's route
  const response = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`call API: ${path} failed (${response.status})`);
  return response.json();
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
 * Asks the Worker to start a cloud recording with R2 storage_config
 * (増分④). Members only — guests get 403. Returns the provider recording id.
 */
export async function startCallRecording(
  getToken: AuthTokenGetter,
  meetingId: string,
): Promise<string> {
  return stringField(
    await post(getToken, `/calls/meetings/${meetingId}/recordings`, {}),
    'recordingId',
  );
}

/** Asks the Worker to stop an active recording (members only). */
export async function stopCallRecording(
  getToken: AuthTokenGetter,
  recordingId: string,
): Promise<void> {
  await post(getToken, `/calls/recordings/${recordingId}/stop`, {});
}

/**
 * Downloads one uploaded recording through the Worker (members only).
 * The Worker resolves `recordings/id/<recordingId>` itself — the client
 * never supplies an object key (a free-form key was a review finding).
 */
export async function downloadCallRecording(
  getToken: AuthTokenGetter,
  recordingId: string,
): Promise<Blob> {
  const token = (await getToken()) ?? storedSessionToken();
  if (token === undefined) throw new Error('call API: no auth token');
  // fallow-ignore-next-line security-sink -- BASE_URL is build-time; recordingId is UUID-shaped at the reducer write
  const response = await fetch(`${BASE_URL}/calls/recordings/${recordingId}/download`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`call API: download failed (${response.status})`);
  return response.blob();
}
