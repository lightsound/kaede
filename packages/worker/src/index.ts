// fallow-ignore-file coverage-gaps -- the Worker fetch wiring: routes, CORS, auth, webhook relay and R2 streaming over live network calls; runs only inside workerd. Every rule worth testing is in rules.ts (unit-tested); the network halves are clerk.ts / realtimekit.ts / spacetime.ts / webhook.ts / module.ts
// fallow-ignore-file unused-export unused-type -- the default export is the Worker entry workerd loads (nothing in this repo imports it), and Env is its bindings contract with infra/alchemy.run.ts / wrangler-call.jsonc

// kaede の通話 API Worker (ROADMAP Phase 4 増分①〜④) — the first of the
// thin stateless glue Workers VISION limits the backend to: RealtimeKit
// meeting/token/recording calls (secrets the browser must never hold),
// webhook → SpacetimeDB reducer relay, and R2 blob download. It keeps no
// state of its own: group↔meeting lives in group_call, the recording
// catalog in call_recording.
//
// Deployed by infra/alchemy.run.ts (Worker `kaede-call`); the wrangler
// escape hatch is infra/wrangler-call.jsonc. Local dev runs `wrangler dev`
// against the same entry with .dev.vars — see README「通話 API Worker」.
import { recordingStatusFromProvider } from '@kaede/shared';
import { verifiedMemberSubject } from './clerk';
import { upsertRecordingStatus } from './module';
import {
  createMeeting,
  mintParticipantToken,
  startRecording,
  stopRecording,
  type RecordingStorageConfig,
} from './realtimekit';
import {
  allowedOrigin,
  bearerTokenFrom,
  callerKindOf,
  participantNameFrom,
  recordingObjectKey,
  recordingWebhookFieldsFrom,
  routeCallRequest,
  routeNeedsCaller,
  routeNeedsMember,
  unverifiedIssuerOf,
  type CallRoute,
} from './rules';
import { verifiedGuestSubject } from './spacetime';
import { verifyRtkSignature } from './webhook';

/** The bindings infra/alchemy.run.ts declares for this Worker. */
export interface Env {
  /** Cloudflare account API token with Realtime Admin (secret). */
  REALTIMEKIT_API_TOKEN: string;
  /** The RealtimeKit app every meeting lives under (a public identifier). */
  REALTIMEKIT_APP_ID: string;
  /** The Cloudflare account the app belongs to (a public identifier). */
  CLOUDFLARE_ACCOUNT_ID: string;
  /** The Clerk issuer whose members may call this API (one per environment). */
  CLERK_ISSUER: string;
  /** The `aud` the client's JWT template pins (kaede-spacetimedb). */
  CLERK_AUDIENCE: string;
  /** The SpacetimeDB host whose guest identities may call this API (増分②). */
  SPACETIME_HOST_URL: string;
  /** Comma-separated browser origins allowed to call this API. */
  ALLOWED_ORIGINS: string;
  /** SpacetimeDB database name for webhook→reducer relay (増分④). */
  SPACETIME_DB_NAME: string;
  /** Shared secret for upsert_call_recording_status (secret). */
  CALL_SERVICE_SECRET: string;
  /** R2 S3 access key for RealtimeKit storage_config (secret). */
  R2_ACCESS_KEY_ID: string;
  /** R2 S3 secret for RealtimeKit storage_config (secret). */
  R2_SECRET_ACCESS_KEY: string;
  /** R2 bucket name the recordings land in (plain var; also the binding). */
  R2_BUCKET_NAME: string;
  /** Alchemy/wrangler R2 binding for download streaming. */
  RECORDINGS: R2Bucket;
}

function json(status: number, body: unknown, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...cors },
  });
}

function providerCfg(env: Env) {
  return {
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    appId: env.REALTIMEKIT_APP_ID,
    apiToken: env.REALTIMEKIT_API_TOKEN,
  };
}

function storageCfg(env: Env): RecordingStorageConfig {
  return {
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    bucket: env.R2_BUCKET_NAME,
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
  };
}

/** Verified caller: subject plus whether they are a space member (Clerk). */
interface Caller {
  subject: string;
  isMember: boolean;
}

/**
 * Verifies the caller and returns its subject + kind, or undefined to 401.
 * The token's claimed issuer only PICKS the verifier (callerKindOf — each
 * path re-checks everything against its own trust anchor).
 */
async function verifiedCaller(
  authorization: string | null,
  env: Env,
): Promise<Caller | undefined> {
  const token = bearerTokenFrom(authorization);
  if (token === undefined) return undefined;
  const kind = callerKindOf(unverifiedIssuerOf(token), env.CLERK_ISSUER);
  if (kind === 'member') {
    const subject = await verifiedMemberSubject(token, env.CLERK_ISSUER, env.CLERK_AUDIENCE);
    return subject === undefined ? undefined : { subject, isMember: true };
  }
  if (kind === 'guest') {
    const subject = await verifiedGuestSubject(token, env.SPACETIME_HOST_URL);
    return subject === undefined ? undefined : { subject, isMember: false };
  }
  return undefined;
}

/** Dispatches one authenticated, routed browser request. */
async function handleBrowserCall(
  route: CallRoute,
  request: Request,
  env: Env,
  caller: Caller,
): Promise<Response> {
  if (routeNeedsMember(route) && !caller.isMember) {
    return json(403, { error: 'forbidden' }, {});
  }
  const cfg = providerCfg(env);
  if (route.kind === 'provision') {
    return json(201, { meetingId: await createMeeting(cfg) }, {});
  }
  if (route.kind === 'mint') {
    const body: unknown = await request.json().catch(() => undefined);
    const name = participantNameFrom(body);
    return json(
      201,
      {
        authToken: await mintParticipantToken(
          cfg,
          route.meetingId,
          name,
          caller.subject,
          caller.isMember,
        ),
      },
      {},
    );
  }
  if (route.kind === 'startRecording') {
    const recordingId = await startRecording(cfg, route.meetingId, storageCfg(env));
    return json(201, { recordingId }, {});
  }
  if (route.kind === 'stopRecording') {
    await stopRecording(cfg, route.recordingId);
    return json(200, { ok: true }, {});
  }
  if (route.kind === 'downloadRecording') {
    // objectKey is not in the URL — the client passes it as ?key= so the
    // Worker does not need to read SpacetimeDB. The key must live under
    // our recordings/ prefix (defense in depth against path traversal).
    const key = new URL(request.url).searchParams.get('key') ?? '';
    if (!key.startsWith('recordings/') || key.includes('..')) {
      return json(400, { error: 'bad-key' }, {});
    }
    const object = await env.RECORDINGS.get(key);
    if (object === null) return json(404, { error: 'not-found' }, {});
    const headers = new Headers();
    headers.set('content-type', object.httpMetadata?.contentType ?? 'video/mp4');
    headers.set(
      'content-disposition',
      `attachment; filename="${key.split('/').pop() ?? 'recording.mp4'}"`,
    );
    if (object.size > 0) headers.set('content-length', String(object.size));
    return new Response(object.body, { status: 200, headers });
  }
  return json(404, { error: 'not-found' }, {});
}

/**
 * Handles a verified recording.statusUpdate: map status, derive object
 * key, optionally copy from provider downloadUrl into R2 (Toggle path
 * fallback when storage_config was not on the start), then upsert the
 * SpacetimeDB catalog row.
 */
async function handleRecordingWebhook(env: Env, fields: ReturnType<typeof recordingWebhookFieldsFrom>): Promise<void> {
  if (fields === undefined) return;
  const status = recordingStatusFromProvider(fields.status);
  if (status === undefined) {
    console.warn('ignoring unknown recording status', fields.status);
    return;
  }
  let objectKey =
    fields.outputFileName === '' ? '' : recordingObjectKey(fields.meetingId, fields.outputFileName);
  if (status === 'uploaded' && objectKey !== '') {
    const existing = await env.RECORDINGS.head(objectKey);
    if (existing === null && fields.downloadUrl !== '') {
      // Fallback: client-SDK start without our storage_config left the
      // file on RealtimeKit's bucket — copy into ours (spike's alternate
      // path; primary is storage_config on Worker start).
      try {
        const download = await fetch(fields.downloadUrl);
        if (download.ok && download.body !== null) {
          await env.RECORDINGS.put(objectKey, download.body, {
            httpMetadata: { contentType: 'video/mp4' },
          });
        } else {
          console.error('recording download fallback failed', download.status);
          objectKey = '';
        }
      } catch (err) {
        console.error('recording download fallback error', err);
        objectKey = '';
      }
    }
  }
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = allowedOrigin(request.headers.get('origin'), env.ALLOWED_ORIGINS);
    const cors: Record<string, string> =
      origin === undefined ? {} : { 'access-control-allow-origin': origin };
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          ...cors,
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'authorization, content-type',
          'access-control-max-age': '86400',
        },
      });
    }
    const route = routeCallRequest(request.method, new URL(request.url).pathname);
    if (route === undefined) return json(404, { error: 'not-found' }, cors);

    if (route.kind === 'webhook') {
      const raw = await request.arrayBuffer();
      const ok = await verifyRtkSignature(request.headers.get('rtk-signature'), raw);
      if (!ok) return json(401, { error: 'unauthorized' }, {});
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(raw));
      } catch {
        return json(400, { error: 'bad-json' }, {});
      }
      try {
        await handleRecordingWebhook(env, recordingWebhookFieldsFrom(parsed));
      } catch (err) {
        console.error('webhook handling failed', err);
        // 5xx so RealtimeKit retries (docs: only <500 non-2xx are terminal).
        return json(502, { error: 'relay-error' }, {});
      }
      return new Response(null, { status: 204 });
    }

    if (!routeNeedsCaller(route)) return json(404, { error: 'not-found' }, cors);
    const caller = await verifiedCaller(request.headers.get('authorization'), env);
    if (caller === undefined) return json(401, { error: 'unauthorized' }, cors);
    try {
      const response = await handleBrowserCall(route, request, env, caller);
      // Re-apply CORS on the JSON/stream responses that omitted it.
      if (origin !== undefined) {
        const headers = new Headers(response.headers);
        headers.set('access-control-allow-origin', origin);
        return new Response(response.body, { status: response.status, headers });
      }
      return response;
    } catch (err) {
      console.error('call API failure', err);
      return json(502, { error: 'provider-error' }, cors);
    }
  },
};
