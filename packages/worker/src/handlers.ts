// fallow-ignore-file coverage-gaps -- browser-call and webhook handlers over live R2 / RealtimeKit / SpacetimeDB; request rules live in rules.ts (unit-tested)

// Thin dispatch helpers for index.ts — split so each uncovered function
// stays under the CRAP budget (the backfillAccountName precedent).
import { isRecordingIdLike, recordingStatusFromProvider } from '@kaede/shared';
import { upsertRecordingStatus } from './module';
import {
  createMeeting,
  mintParticipantToken,
  type ProviderConfig,
  type RecordingStorageConfig,
  startRecording,
  stopRecording,
} from './realtimekit';
import {
  type CallRoute,
  participantNameFrom,
  recordingArchiveKey,
  recordingObjectKey,
  recordingWebhookFieldsFrom,
} from './rules';

export interface Caller {
  subject: string;
  isMember: boolean;
}

export interface HandlerEnv {
  RECORDINGS: R2Bucket;
  SPACETIME_HOST_URL: string;
  SPACETIME_DB_NAME: string;
  CALL_SERVICE_SECRET: string;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function recordingContentType(object: R2ObjectBody): string {
  return object.httpMetadata?.contentType ?? 'video/mp4';
}

function recordingFilename(key: string, fallback: string): string {
  return key.split('/').pop() ?? fallback;
}

/** Attachment headers for one R2 object body. */
function recordingDownloadHeaders(object: R2ObjectBody, key: string): Headers {
  const headers = new Headers();
  headers.set('content-type', recordingContentType(object));
  headers.set(
    'content-disposition',
    `attachment; filename="${recordingFilename(key, 'recording.mp4')}"`,
  );
  if (object.size > 0) headers.set('content-length', String(object.size));
  return headers;
}

/**
 * Streams the archive object for `recordingId`. The key is derived only
 * from the path id (`recordings/id/<recordingId>`) — never from a client
 * query param (Bugbot: download must not accept a free-form object key).
 */
async function streamRecordingDownload(env: HandlerEnv, recordingId: string): Promise<Response> {
  if (!isRecordingIdLike(recordingId)) return json(400, { error: 'bad-id' });
  const key = recordingArchiveKey(recordingId);
  const object = await env.RECORDINGS.get(key);
  if (object === null) return json(404, { error: 'not-found' });
  return new Response(object.body, { status: 200, headers: recordingDownloadHeaders(object, key) });
}

async function mintResponse(
  cfg: ProviderConfig,
  meetingId: string,
  request: Request,
  caller: Caller,
): Promise<Response> {
  const body: unknown = await request.json().catch(() => undefined);
  return json(201, {
    authToken: await mintParticipantToken(
      cfg,
      meetingId,
      participantNameFrom(body),
      caller.subject,
      caller.isMember,
    ),
  });
}

/** Recording start/stop/download half of the browser dispatch. */
async function handleRecordingRoute(
  route: CallRoute,
  cfg: ProviderConfig,
  storage: RecordingStorageConfig,
  env: HandlerEnv,
): Promise<Response | undefined> {
  if (route.kind === 'startRecording') {
    return json(201, { recordingId: await startRecording(cfg, route.meetingId, storage) });
  }
  if (route.kind === 'stopRecording') {
    await stopRecording(cfg, route.recordingId);
    return json(200, { ok: true });
  }
  if (route.kind === 'downloadRecording') {
    return streamRecordingDownload(env, route.recordingId);
  }
  return undefined;
}

/** One authenticated browser route → provider / R2 response. */
export async function handleBrowserCall(
  route: CallRoute,
  request: Request,
  cfg: ProviderConfig,
  storage: RecordingStorageConfig,
  env: HandlerEnv,
  caller: Caller,
): Promise<Response> {
  if (route.kind === 'provision') {
    return json(201, { meetingId: await createMeeting(cfg) });
  }
  if (route.kind === 'mint') {
    return mintResponse(cfg, route.meetingId, request, caller);
  }
  const recording = await handleRecordingRoute(route, cfg, storage, env);
  if (recording !== undefined) return recording;
  return json(404, { error: 'not-found' });
}

/** Fetches provider downloadUrl into R2 when the object is absent. */
async function putDownloadUrlInR2(
  env: HandlerEnv,
  objectKey: string,
  downloadUrl: string,
): Promise<string> {
  try {
    // fallow-ignore-next-line security-sink -- downloadUrl is from a signature-verified RealtimeKit recording.statusUpdate webhook (verifyRtkSignature), not browser input
    const download = await fetch(downloadUrl);
    if (!download.ok || download.body === null) {
      console.error('recording download fallback failed', download.status);
      return '';
    }
    await env.RECORDINGS.put(objectKey, download.body, {
      httpMetadata: { contentType: 'video/mp4' },
    });
    return objectKey;
  } catch (err) {
    console.error('recording download fallback error', err);
    return '';
  }
}

/** Copies an existing R2 object onto the archive key (by recording id). */
async function copyToArchiveKey(
  env: HandlerEnv,
  archiveKey: string,
  sourceKey: string,
): Promise<boolean> {
  if (sourceKey === '' || sourceKey === archiveKey) return false;
  const source = await env.RECORDINGS.get(sourceKey);
  if (source === null) return false;
  await env.RECORDINGS.put(archiveKey, source.body, {
    httpMetadata: { contentType: recordingContentType(source) },
  });
  return true;
}

function sourceObjectKey(meetingId: string, outputFileName: string): string {
  if (outputFileName === '') return '';
  return recordingObjectKey(meetingId, outputFileName);
}

/**
 * Lands the file at `recordings/id/<recordingId>` for download-by-id.
 * Prefers the storage_config upload path; falls back to provider downloadUrl.
 */
async function ensureArchiveObject(
  env: HandlerEnv,
  recordingId: string,
  meetingId: string,
  outputFileName: string,
  downloadUrl: string,
): Promise<string> {
  const archiveKey = recordingArchiveKey(recordingId);
  if ((await env.RECORDINGS.head(archiveKey)) !== null) return archiveKey;
  if (await copyToArchiveKey(env, archiveKey, sourceObjectKey(meetingId, outputFileName))) {
    return archiveKey;
  }
  return downloadUrl === '' ? '' : putDownloadUrlInR2(env, archiveKey, downloadUrl);
}

/**
 * Handles a verified recording.statusUpdate: map status, ensure the R2
 * archive object, upsert the SpacetimeDB catalog row.
 */
export async function handleRecordingWebhook(env: HandlerEnv, body: unknown): Promise<void> {
  const fields = recordingWebhookFieldsFrom(body);
  if (fields === undefined) return;
  const status = recordingStatusFromProvider(fields.status);
  if (status === undefined) {
    console.warn('ignoring unknown recording status', fields.status);
    return;
  }
  const objectKey =
    status === 'uploaded'
      ? await ensureArchiveObject(
          env,
          fields.recordingId,
          fields.meetingId,
          fields.outputFileName,
          fields.downloadUrl,
        )
      : '';
  await upsertRecordingStatus(
    {
      hostUrl: env.SPACETIME_HOST_URL,
      database: env.SPACETIME_DB_NAME,
      serviceSecret: env.CALL_SERVICE_SECRET,
    },
    {
      recordingId: fields.recordingId,
      meetingId: fields.meetingId,
      status,
      objectKey,
      outputFileName: fields.outputFileName,
      startedAtMs: fields.startedAtMs,
      durationSecs: fields.durationSecs,
    },
  );
}
