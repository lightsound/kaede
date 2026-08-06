// fallow-ignore-file coverage-gaps -- thin fetch wrappers over the RealtimeKit REST API; they need the live provider, not a unit test (scripts/spike-realtimekit.sh is their standing manual probe). The request-level rules live in rules.ts and are unit-tested

// The provider half of the call API (ROADMAP Phase 4 増分①・④): the ONLY
// place kaede's server side talks to RealtimeKit — meetings, participant
// tokens, and since 増分④ the cloud recording control (start with R2
// direct upload, stop via the active-recording probe). The client-side
// counterpart is packages/client's call.package; between them, swapping
// providers (LiveKit etc. — VISION) is these two modules plus the infra
// bindings, nothing else.
//
// API shape (verified live by the 増分0 spike, docs/ROADMAP.md Phase 4):
// Cloudflare account API with a Realtime-Admin token, top-level
// `{success, data}` envelopes, meetings as reusable rooms, participant
// tokens minted per join via Add Participant.

/** What every provider call needs — the Worker env's provider slice. */
export interface ProviderConfig {
  accountId: string;
  appId: string;
  apiToken: string;
}

/**
 * The preset participants join under: RealtimeKit auto-provisions it with
 * the app (増分0 spike) — GROUP_CALL view, AV + screenshare allowed,
 * can_record false. Recording arrives in a later increment with its own
 * preset decision.
 */
const PARTICIPANT_PRESET = 'group_call_participant';

class ProviderError extends Error {}

/** Whether the response body is RealtimeKit's success envelope (増分0 spike). */
function isSuccessEnvelope(payload: unknown): payload is { success: true; data?: unknown } {
  const record = (payload ?? {}) as Record<string, unknown>;
  return record.success === true;
}

async function providerFetch(
  cfg: ProviderConfig,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body?: unknown,
): Promise<Response> {
  const base = `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/realtime/kit`;
  // fallow-ignore-next-line security-sink -- the host is the Cloudflare API literal; accountId/appId are deploy-time bindings (infra/alchemy.run.ts), and the only request-derived segment is a meeting id vetted to UUID shape by routeCallRequest
  return fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${cfg.apiToken}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/**
 * One provider call whose failure is exceptional (the original shape —
 * every route except the active-recording probe, which reads a 404 as an
 * answer). Bodies never carry the R2 secret the recording start sends:
 * the log line is the path + status + payload, and the start response
 * echoes storage_config as null (live-probed 2026-08-06).
 */
async function providerRequest(
  cfg: ProviderConfig,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body?: unknown,
): Promise<unknown> {
  const response = await providerFetch(cfg, method, path, body);
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok || !isSuccessEnvelope(payload)) {
    // The response body may carry provider internals; log it for Workers
    // Logs but never forward it to the browser (index.ts maps this to an
    // opaque 502).
    console.error('RealtimeKit API failure', path, response.status, JSON.stringify(payload));
    throw new ProviderError(`RealtimeKit ${path} failed (${response.status})`);
  }
  return payload.data;
}

function stringField(data: unknown, field: string): string {
  const value = (data as Record<string, unknown> | null | undefined)?.[field];
  if (typeof value === 'string' && value !== '') return value;
  throw new ProviderError(`RealtimeKit response missing ${field}`);
}

/** Creates one meeting (a reusable room) and returns its id. */
export async function createMeeting(cfg: ProviderConfig): Promise<string> {
  const data = await providerRequest(cfg, 'POST', `/${cfg.appId}/meetings`, {
    title: 'kaede 通話',
  });
  return stringField(data, 'id');
}

/**
 * Mints one participant token for `meetingId` (Add Participant — a fresh
 * participant per join, discarded on leave; at 2,400h token life the
 * refresh API exists but is never needed, 増分0 spike). `participantId`
 * is the verified Clerk subject, recorded provider-side as
 * custom_participant_id for future correlation (recording access, cost
 * attribution).
 */
export async function mintParticipantToken(
  cfg: ProviderConfig,
  meetingId: string,
  name: string,
  participantId: string,
): Promise<string> {
  const data = await providerRequest(
    cfg,
    'POST',
    `/${cfg.appId}/meetings/${meetingId}/participants`,
    {
      name,
      preset_name: PARTICIPANT_PRESET,
      custom_participant_id: participantId,
    },
  );
  return stringField(data, 'token');
}

/** The R2 upload target a recording start carries (storage_config). */
export interface RecordingStorage {
  accessKey: string;
  secret: string;
  bucket: string;
  path: string;
  accountId: string;
}

/**
 * Starts one cloud recording of `meetingId`, uploading straight to R2
 * (storage_config type=cloudflare — the 増分0 spike's ⑥, live-verified
 * end-to-end 2026-08-06: INVOKED → UPLOADED → the object in the bucket).
 * Returns the recording file's basename, which the provider fixes AT
 * START TIME (the response's output_file_name) — the exact join key the
 * starter's client writes into the call_recording label row.
 */
export async function startCloudRecording(
  cfg: ProviderConfig,
  meetingId: string,
  storage: RecordingStorage,
): Promise<string> {
  const data = await providerRequest(cfg, 'POST', `/${cfg.appId}/recordings`, {
    meeting_id: meetingId,
    storage_config: {
      type: 'cloudflare',
      access_key: storage.accessKey,
      secret: storage.secret,
      bucket: storage.bucket,
      path: storage.path,
      account_id: storage.accountId,
    },
  });
  return stringField(data, 'output_file_name');
}

/**
 * Stops `meetingId`'s active recording, or reports there is none (the
 * provider's 404 on the active-recording probe — an ANSWER here, not a
 * failure: a stop can race the unattended auto-stop or another member's
 * stop, and the outcome the user asked for is true either way). The
 * Worker stays stateless: which recording to stop is the provider's
 * lookup, never a stored id.
 */
export async function stopCloudRecording(
  cfg: ProviderConfig,
  meetingId: string,
): Promise<'stopped' | 'no-active-recording'> {
  const probe = await providerFetch(
    cfg,
    'GET',
    `/${cfg.appId}/recordings/active-recording/${meetingId}`,
  );
  if (probe.status === 404) return 'no-active-recording';
  const payload: unknown = await probe.json().catch(() => undefined);
  if (!probe.ok || !isSuccessEnvelope(payload)) {
    console.error('RealtimeKit API failure', 'active-recording', probe.status);
    throw new ProviderError(`RealtimeKit active-recording failed (${probe.status})`);
  }
  const recordingId = stringField(payload.data, 'id');
  await providerRequest(cfg, 'PUT', `/${cfg.appId}/recordings/${recordingId}`, {
    action: 'stop',
  });
  return 'stopped';
}
