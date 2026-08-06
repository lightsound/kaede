// fallow-ignore-file coverage-gaps -- synchronous ctx.http wrappers over the RealtimeKit REST API and the R2 S3 API; they need the live providers and only run inside a SpacetimeDB module host. The pure halves (SigV4 signing, listing parse) live in @kaede/shared's s3.ts and are unit-tested there

// The provider half of the call/recording procedures (ROADMAP Phase 4
// 増分⑥): the ONLY place kaede's server side talks to RealtimeKit —
// meetings, participant tokens, cloud recording control — and to the R2
// bucket (listing, presigned downloads). Moved here from packages/worker
// when the procedures replaced the call-API Worker (増分⑥ D2): a
// procedure's ctx.http.fetch is SYNCHRONOUS, so these are plain functions,
// not async. The client-side counterpart is packages/client's
// call.package; between them, swapping providers (LiveKit etc. — VISION)
// is these two modules, nothing else.
//
// API shape (verified live by the 増分0 spike, docs/ROADMAP.md Phase 4):
// Cloudflare account API with a Realtime-Admin token, top-level
// `{success, data}` envelopes, meetings as reusable rooms, participant
// tokens minted per join via Add Participant.
//
// Not re-exported from index.ts (the host refuses non-spacetime entry
// exports — the world.ts rule); calls.ts is the only consumer.
import {
  parseBucketListing,
  presignedS3Url,
  RECORDINGS_PREFIX,
  type RecordingObject,
  recordingObjectKey,
} from '@kaede/shared';
import type { InferSchema, ProcedureCtx } from 'spacetimedb/server';
import type { spacetimedb } from './tables';
import type { Ctx } from './world';

/** The synchronous HTTP client a procedure exposes (ctx.http). */
export type Http = ProcedureCtx<InferSchema<typeof spacetimedb>>['http'];

/** The provider configuration row (call_config in tables.ts, seeded by owner SQL). */
export type CallConfig = NonNullable<ReturnType<Ctx['db']['callConfig']['id']['find']>>;

/**
 * The preset participants join under: RealtimeKit auto-provisions it with
 * the app (増分0 spike) — GROUP_CALL view, AV + screenshare allowed,
 * can_record false (the recording authority is the module's approved-member
 * gate, not the preset — 増分④ 設計②).
 */
const PARTICIPANT_PRESET = 'group_call_participant';

// Timeout budgets per external API (増分⑥ D6 — measured 2026-08-06, five
// samples each against the live providers): meeting create 0.54–0.92s,
// participant mint 0.63–0.90s, active-recording probe ~0.69s, stop
// 0.6–0.9s, recording start 2.5s (it spins a recorder up), R2 list
// 0.14–0.17s. Budgets sit 5–10x over the worst sample; a timeout rejects
// the procedure and the retry is the browser's (the user re-clicks —
// no module-side retry by decision D6).
const REALTIMEKIT_TIMEOUT_MS = 5_000;
const RECORDING_START_TIMEOUT_MS = 10_000;
const R2_TIMEOUT_MS = 3_000;

/** RequestOptions.timeout wants a TimeDuration; built structurally because
 * the class itself is not exported from 'spacetimedb/server' (the type is). */
function timeoutOf(ms: number): NonNullable<Parameters<Http['fetch']>[1]>['timeout'] {
  return { __time_duration_micros__: BigInt(ms) * 1000n } as NonNullable<
    Parameters<Http['fetch']>[1]
  >['timeout'];
}

/** How long a presigned download URL stays valid. Long enough to click and
 * for the browser to START the transfer (R2 checks expiry at request time,
 * not mid-stream); short enough that a leaked URL is a stale one. */
const DOWNLOAD_URL_TTL_SECONDS = 600;

/** Whether the response body is RealtimeKit's success envelope (増分0 spike). */
function isSuccessEnvelope(payload: unknown): payload is { success: true; data?: unknown } {
  const record = (payload ?? {}) as Record<string, unknown>;
  return record.success === true;
}

function providerFetch(
  http: Http,
  cfg: CallConfig,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body: unknown,
  timeoutMs: number,
) {
  // The host is the Cloudflare API literal; accountId/appId come from the
  // owner-seeded call_config row, and the only runtime segment is a meeting
  // id this module itself received from the provider.
  const base = `https://api.cloudflare.com/client/v4/accounts/${cfg.cloudflareAccountId}/realtime/kit`;
  return http.fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${cfg.realtimekitToken}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    timeout: timeoutOf(timeoutMs),
  });
}

/**
 * One provider call whose failure is exceptional (every route except the
 * active-recording probe, which reads a 404 as an answer). Bodies never
 * carry the R2 secret the recording start sends: the log line is the
 * path + status + payload, and the start response echoes storage_config
 * as null (live-probed 2026-08-06).
 */
function providerRequest(
  http: Http,
  cfg: CallConfig,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body?: unknown,
  timeoutMs: number = REALTIMEKIT_TIMEOUT_MS,
): unknown {
  const response = providerFetch(http, cfg, method, path, body, timeoutMs);
  const payload: unknown = parsedJson(response.text());
  if (!response.ok || !isSuccessEnvelope(payload)) {
    // The response body may carry provider internals; log it for the
    // module log but never hand it to the client (the thrown message is
    // what the rejected procedure call carries).
    console.error('RealtimeKit API failure', path, response.status, JSON.stringify(payload));
    throw new Error(`RealtimeKit call failed (${response.status})`);
  }
  return payload.data;
}

function parsedJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function stringField(data: unknown, field: string): string {
  const value = (data as Record<string, unknown> | null | undefined)?.[field];
  if (typeof value === 'string' && value !== '') return value;
  throw new Error(`RealtimeKit response missing ${field}`);
}

/** Creates one meeting (a reusable room) and returns its id. */
export function createMeeting(http: Http, cfg: CallConfig): string {
  const data = providerRequest(http, cfg, 'POST', `/${cfg.realtimekitAppId}/meetings`, {
    title: 'kaede 通話',
  });
  return stringField(data, 'id');
}

/**
 * Mints one participant token for `meetingId` (Add Participant — a fresh
 * participant per join, discarded on leave; at 2,400h token life the
 * refresh API exists but is never needed, 増分0 spike). `participantId`
 * is the member's Clerk subject or the guest's Identity hex, recorded
 * provider-side as custom_participant_id for future correlation
 * (recording access, cost attribution).
 */
export function mintParticipantToken(
  http: Http,
  cfg: CallConfig,
  meetingId: string,
  name: string,
  participantId: string,
): string {
  const data = providerRequest(
    http,
    cfg,
    'POST',
    `/${cfg.realtimekitAppId}/meetings/${meetingId}/participants`,
    {
      name,
      preset_name: PARTICIPANT_PRESET,
      custom_participant_id: participantId,
    },
  );
  return stringField(data, 'token');
}

/**
 * Starts one cloud recording of `meetingId`, uploading straight to R2
 * (storage_config type=cloudflare — the 増分0 spike's ⑥, live-verified
 * end-to-end 2026-08-06: INVOKED → UPLOADED → the object in the bucket).
 * Returns the recording file's basename, which the provider fixes AT
 * START TIME (the response's output_file_name) — the exact join key the
 * calling procedure writes into the call_recording label row.
 */
export function startCloudRecording(http: Http, cfg: CallConfig, meetingId: string): string {
  const data = providerRequest(
    http,
    cfg,
    'POST',
    `/${cfg.realtimekitAppId}/recordings`,
    {
      meeting_id: meetingId,
      storage_config: {
        type: 'cloudflare',
        access_key: cfg.storageAccessKeyId,
        secret: cfg.storageSecretAccessKey,
        bucket: cfg.storageBucket,
        path: RECORDINGS_PREFIX,
        account_id: cfg.cloudflareAccountId,
      },
    },
    RECORDING_START_TIMEOUT_MS,
  );
  return stringField(data, 'output_file_name');
}

/**
 * Stops `meetingId`'s active recording, or reports there is none (the
 * provider's 404 on the active-recording probe — an ANSWER here, not a
 * failure: a stop can race the unattended auto-stop or another member's
 * stop, and the outcome the user asked for is true either way). Which
 * recording to stop is the provider's lookup, never a stored id (the
 * stateless rule, carried over from the Worker).
 */
export function stopCloudRecording(
  http: Http,
  cfg: CallConfig,
  meetingId: string,
): 'stopped' | 'no-active-recording' {
  const probe = providerFetch(
    http,
    cfg,
    'GET',
    `/${cfg.realtimekitAppId}/recordings/active-recording/${meetingId}`,
    undefined,
    REALTIMEKIT_TIMEOUT_MS,
  );
  if (probe.status === 404) return 'no-active-recording';
  const payload: unknown = parsedJson(probe.text());
  if (!probe.ok || !isSuccessEnvelope(payload)) {
    console.error('RealtimeKit API failure', 'active-recording', probe.status);
    throw new Error(`RealtimeKit call failed (${probe.status})`);
  }
  const recordingId = stringField(payload.data, 'id');
  providerRequest(http, cfg, 'PUT', `/${cfg.realtimekitAppId}/recordings/${recordingId}`, {
    action: 'stop',
  });
  return 'stopped';
}

/** The bucket's S3 host and the SigV4 inputs shared by both R2 reads. */
function r2Host(cfg: CallConfig): string {
  return `${cfg.cloudflareAccountId}.r2.cloudflarestorage.com`;
}

function r2Credentials(cfg: CallConfig) {
  return { accessKeyId: cfg.storageAccessKeyId, secretAccessKey: cfg.storageSecretAccessKey };
}

/** R2's SigV4 region is the literal 'auto'. */
const R2_REGION = 'auto';

/** How long the listing's own presigned URL lives: one immediate fetch. */
const LIST_URL_TTL_SECONDS = 60;

/**
 * The finished recordings under the recordings prefix, newest first. One
 * unpaginated ListObjectsV2 page (1,000 keys) — an order of magnitude
 * over the label table's own retention (RECORDING_HISTORY_MAX), so
 * pagination would outlive the product shape that needs it. The request
 * authenticates through a PRESIGNED URL fetched immediately, never
 * through SigV4 headers: the SDK's Headers class splits the Authorization
 * header's commas into a header list, which arrives as duplicate
 * Authorization headers and a 400 (see presignedS3Url in @kaede/shared).
 * `nowMs` is the procedure's own timestamp (SigV4 dates the request).
 */
export function listRecordingObjects(
  http: Http,
  cfg: CallConfig,
  nowMs: number,
): RecordingObject[] {
  // The host and bucket come from the owner-seeded call_config row; the
  // query is a literal.
  const url = presignedS3Url(
    {
      method: 'GET',
      host: r2Host(cfg),
      path: `/${cfg.storageBucket}`,
      query: [
        ['list-type', '2'],
        ['prefix', `${RECORDINGS_PREFIX}/`],
      ],
    },
    r2Credentials(cfg),
    nowMs,
    LIST_URL_TTL_SECONDS,
    R2_REGION,
  );
  if (url === undefined) throw new Error('R2 listing could not be signed');
  const response = http.fetch(url, { method: 'GET', timeout: timeoutOf(R2_TIMEOUT_MS) });
  if (!response.ok) {
    console.error('R2 list failure', response.status);
    throw new Error(`R2 list failed (${response.status})`);
  }
  const objects = parseBucketListing(response.text());
  return objects.sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
}

/**
 * A presigned GET for one recording, so the browser downloads straight
 * from R2 (an <a href> needs no Authorization header, and the stream
 * never rides the module). Pure signing — no external HTTP. `fileName`
 * was vetted to the provider naming by the procedure
 * (isRecordingFileNameLike), which is also what makes a key outside the
 * recordings prefix unrepresentable. The signed response override makes
 * the browser SAVE the file instead of navigating into an inline player.
 */
export function presignRecordingDownload(cfg: CallConfig, fileName: string, nowMs: number): string {
  const url = presignedS3Url(
    {
      method: 'GET',
      host: r2Host(cfg),
      path: `/${cfg.storageBucket}/${recordingObjectKey(fileName)}`,
      query: [['response-content-disposition', `attachment; filename="${fileName}"`]],
    },
    r2Credentials(cfg),
    nowMs,
    DOWNLOAD_URL_TTL_SECONDS,
    R2_REGION,
  );
  if (url === undefined) throw new Error('download URL could not be signed');
  return url;
}
