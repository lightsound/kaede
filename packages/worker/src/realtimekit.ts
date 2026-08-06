// fallow-ignore-file coverage-gaps -- thin fetch wrappers over the RealtimeKit REST API; they need the live provider, not a unit test (scripts/spike-realtimekit.sh is their standing manual probe). The request-level rules live in rules.ts and are unit-tested

// The provider half of the call API (ROADMAP Phase 4 増分①〜④): the ONLY
// place kaede's server side talks to RealtimeKit. The client-side
// counterpart is packages/client's call.package; between them, swapping
// providers (LiveKit etc. — VISION) is these modules plus the infra
// bindings, nothing else.
//
// API shape (verified live by the 増分0 spike, docs/ROADMAP.md Phase 4):
// Cloudflare account API with a Realtime-Admin token, top-level
// `{success, data}` envelopes, meetings as reusable rooms, participant
// tokens minted per join via Add Participant, recordings started with
// storage_config for R2 direct upload (増分④).

import { recordingObjectPrefix } from './rules';

/** What every provider call needs — the Worker env's provider slice. */
export interface ProviderConfig {
  accountId: string;
  appId: string;
  apiToken: string;
}

/** R2 S3 credentials passed as RealtimeKit storage_config (増分④). */
export interface RecordingStorageConfig {
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  accountId: string;
}

/**
 * Presets RealtimeKit auto-provisions with the app (増分0 spike).
 * Members join as host (can_record=true — the recording toggle); guests
 * stay on participant (can_record=false). kick/pin/spotlight ride along
 * on host; narrowing those later is a dedicated-preset task (ROADMAP).
 */
const MEMBER_PRESET = 'group_call_host';
const GUEST_PRESET = 'group_call_participant';

class ProviderError extends Error {}

/** Whether the response body is RealtimeKit's success envelope (増分0 spike). */
function isSuccessEnvelope(payload: unknown): payload is { success: true; data?: unknown } {
  const record = (payload ?? {}) as Record<string, unknown>;
  return record.success === true;
}

async function providerFetch(
  cfg: ProviderConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const base = `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/realtime/kit`;
  // fallow-ignore-next-line security-sink -- the host is the Cloudflare API literal; accountId/appId are deploy-time bindings (infra/alchemy.run.ts), and request-derived segments are UUID-vetted by routeCallRequest
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${cfg.apiToken}`,
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok || !isSuccessEnvelope(payload)) {
    // The response body may carry provider internals; log it for Workers
    // Logs but never forward it to the browser (index.ts maps this to an
    // opaque 502).
    console.error(
      'RealtimeKit API failure',
      method,
      path,
      response.status,
      JSON.stringify(payload),
    );
    throw new ProviderError(`RealtimeKit ${path} failed (${response.status})`);
  }
  return payload.data;
}

function stringField(data: unknown, field: string): string {
  const value = (data as Record<string, unknown> | null | undefined)?.[field];
  if (typeof value === 'string' && value !== '') return value;
  throw new ProviderError(`RealtimeKit response missing ${field}`);
}

function storageConfigBody(storage: RecordingStorageConfig, meetingId: string): unknown {
  return {
    type: 'cloudflare',
    access_key: storage.accessKeyId,
    secret: storage.secretAccessKey,
    bucket: storage.bucket,
    path: recordingObjectPrefix(meetingId),
    account_id: storage.accountId,
  };
}

/** Creates one meeting (a reusable room) and returns its id. */
export async function createMeeting(cfg: ProviderConfig): Promise<string> {
  const data = await providerFetch(cfg, 'POST', `/${cfg.appId}/meetings`, { title: 'kaede 通話' });
  return stringField(data, 'id');
}

/**
 * Mints one participant token for `meetingId` (Add Participant — a fresh
 * participant per join, discarded on leave; at 2,400h token life the
 * refresh API exists but is never needed, 増分0 spike). `participantId`
 * is the verified subject (Clerk user id or SpacetimeDB hex_identity),
 * recorded provider-side as custom_participant_id. `asMember` picks the
 * host vs participant preset (増分④ — only members get can_record).
 */
export async function mintParticipantToken(
  cfg: ProviderConfig,
  meetingId: string,
  name: string,
  participantId: string,
  asMember: boolean,
): Promise<string> {
  const data = await providerFetch(
    cfg,
    'POST',
    `/${cfg.appId}/meetings/${meetingId}/participants`,
    {
      name,
      preset_name: asMember ? MEMBER_PRESET : GUEST_PRESET,
      custom_participant_id: participantId,
    },
  );
  return stringField(data, 'token');
}

/**
 * Starts a cloud recording for `meetingId` with R2 storage_config (spike
 * ⑥'s direct-upload path). Returns the provider recording id.
 */
export async function startRecording(
  cfg: ProviderConfig,
  meetingId: string,
  storage: RecordingStorageConfig,
): Promise<string> {
  const data = await providerFetch(cfg, 'POST', `/${cfg.appId}/recordings`, {
    meeting_id: meetingId,
    storage_config: storageConfigBody(storage, meetingId),
  });
  return stringField(data, 'id');
}

/** Stops an active recording by id. */
export async function stopRecording(cfg: ProviderConfig, recordingId: string): Promise<void> {
  await providerFetch(cfg, 'PUT', `/${cfg.appId}/recordings/${recordingId}/stop`, {});
}
