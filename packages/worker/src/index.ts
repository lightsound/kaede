// fallow-ignore-file coverage-gaps -- the Worker fetch wiring: routes, CORS and error mapping over live network calls; runs only inside workerd. Every rule worth testing is in rules.ts (unit-tested); the network halves are clerk.ts / realtimekit.ts / r2.ts / webhook.ts
// fallow-ignore-file unused-export unused-type -- the default export is the Worker entry workerd loads (nothing in this repo imports it), and Env is its bindings contract with infra/alchemy.run.ts / wrangler-call.jsonc

// kaede の通話 API Worker (ROADMAP Phase 4 増分①〜②・④) — the first of the
// thin stateless glue Workers VISION limits the backend to: it exists ONLY
// because RealtimeKit calls need a secret the browser must never hold
// (and SpacetimeDB modules cannot call external HTTP). It keeps no state:
// which group has which meeting lives in SpacetimeDB (group_call), who may
// join is enforced there too (the members-only RLS filter), and the
// finished recordings live in R2 — this Worker only checks "a kaede
// identity is asking": a signed-in member's Clerk JWT (clerk.ts) or, since
// 増分②, a guest's SpacetimeDB host-issued token (spacetime.ts), and
// forwards to the provider (realtimekit.ts) or the bucket (r2.ts). The
// recording routes are additionally MEMBERS-ONLY (増分④ — routeIsMemberOnly
// in rules.ts), and the webhook route authenticates by provider signature
// instead of a bearer (webhook.ts).
//
// Deployed by infra/alchemy.run.ts (Worker `kaede-call`); the wrangler
// escape hatch is infra/wrangler-call.jsonc. Local dev runs `wrangler dev`
// against the same entry with .dev.vars — see README「通話 API Worker」.
import { verifiedMemberSubject } from './clerk';
import { listRecordings, presignedDownloadUrl, type R2Config } from './r2';
import {
  createMeeting,
  mintParticipantToken,
  type ProviderConfig,
  startCloudRecording,
  stopCloudRecording,
} from './realtimekit';
import {
  allowedOrigin,
  bearerTokenFrom,
  type CallRoute,
  callerKindOf,
  participantNameFrom,
  RECORDINGS_PREFIX,
  routeCallRequest,
  routeIsMemberOnly,
  summarizeRecordingEvent,
  unverifiedIssuerOf,
} from './rules';
import { verifiedGuestSubject } from './spacetime';
import { verifiedWebhookBody } from './webhook';

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
  /** The R2 bucket finished recordings land in (a public identifier, 増分④). */
  RECORDINGS_BUCKET: string;
  /**
   * R2 S3 credentials (secrets, 増分④): what the recording start hands the
   * provider (storage_config) and what mints presigned download URLs.
   * Derived from an R2-permitted API token (access key = token id, secret
   * = SHA-256 of the token value) and synced out-of-band by the CI deploy
   * job, like REALTIMEKIT_API_TOKEN — see README「通話 API Worker」.
   */
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
}

function json(status: number, body: unknown, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...cors },
  });
}

function providerConfig(env: Env): ProviderConfig {
  return {
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    appId: env.REALTIMEKIT_APP_ID,
    apiToken: env.REALTIMEKIT_API_TOKEN,
  };
}

function r2Config(env: Env): R2Config {
  return {
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    bucket: env.RECORDINGS_BUCKET,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  };
}

/** One handled request's outcome, before the JSON/CORS envelope. */
interface CallResult {
  status: number;
  body: unknown;
}

/** The recording control half of the dispatch — split to stay small. */
async function handleRecordingControl(
  route: Extract<CallRoute, { kind: 'record-start' | 'record-stop' }>,
  env: Env,
): Promise<CallResult> {
  const cfg = providerConfig(env);
  if (route.kind === 'record-start') {
    const fileName = await startCloudRecording(cfg, route.meetingId, {
      accessKey: env.R2_ACCESS_KEY_ID,
      secret: env.R2_SECRET_ACCESS_KEY,
      bucket: env.RECORDINGS_BUCKET,
      path: RECORDINGS_PREFIX,
      accountId: env.CLOUDFLARE_ACCOUNT_ID,
    });
    return { status: 201, body: { fileName } };
  }
  const outcome = await stopCloudRecording(cfg, route.meetingId);
  if (outcome === 'no-active-recording') {
    return { status: 404, body: { error: 'no-active-recording' } };
  }
  return { status: 200, body: { stopped: true } };
}

/** The recording read half of the dispatch (the R2 routes). */
async function handleRecordingRead(
  route: Extract<CallRoute, { kind: 'recordings-list' | 'recording-download' }>,
  env: Env,
): Promise<CallResult> {
  if (route.kind === 'recordings-list') {
    return { status: 200, body: { recordings: await listRecordings(r2Config(env)) } };
  }
  return { status: 200, body: { url: await presignedDownloadUrl(r2Config(env), route.fileName) } };
}

/** The 増分① call half of the dispatch (meetings and participant tokens). */
async function handleMeetingCall(
  route: Extract<CallRoute, { kind: 'provision' | 'mint' }>,
  request: Request,
  env: Env,
  subject: string,
): Promise<CallResult> {
  if (route.kind === 'provision') {
    return { status: 201, body: { meetingId: await createMeeting(providerConfig(env)) } };
  }
  const body: unknown = await request.json().catch(() => undefined);
  const name = participantNameFrom(body);
  return {
    status: 201,
    body: {
      authToken: await mintParticipantToken(providerConfig(env), route.meetingId, name, subject),
    },
  };
}

/**
 * Each route kind's handler (the MEMBER_ACTION_CALLS shape in the client:
 * a lookup instead of an if-chain, so the dispatcher stays branch-free
 * under the CRAP budget as route kinds accumulate).
 */
const CALL_HANDLERS: {
  [K in CallRoute['kind']]: (
    route: Extract<CallRoute, { kind: K }>,
    request: Request,
    env: Env,
    subject: string,
  ) => Promise<CallResult>;
} = {
  provision: (route, request, env, subject) => handleMeetingCall(route, request, env, subject),
  mint: (route, request, env, subject) => handleMeetingCall(route, request, env, subject),
  'recordings-list': (route, _request, env) => handleRecordingRead(route, env),
  'recording-download': (route, _request, env) => handleRecordingRead(route, env),
  'record-start': (route, _request, env) => handleRecordingControl(route, env),
  'record-stop': (route, _request, env) => handleRecordingControl(route, env),
};

/** Dispatches one authenticated, routed request to the provider or the bucket. */
function handleCall(
  route: CallRoute,
  request: Request,
  env: Env,
  subject: string,
): Promise<CallResult> {
  const handler = CALL_HANDLERS[route.kind] as (
    route: CallRoute,
    request: Request,
    env: Env,
    subject: string,
  ) => Promise<CallResult>;
  return handler(route, request, env, subject);
}

/** One verified caller: which trust domain vouched, and for which subject. */
interface VerifiedCaller {
  kind: 'member' | 'guest';
  subject: string;
}

/**
 * Verifies the caller, or undefined to 401. The token's claimed issuer
 * only PICKS the verifier (callerKindOf — each path re-checks everything
 * against its own trust anchor): the Clerk member path or, since 増分②,
 * the SpacetimeDB guest path — guests start, join and screen-share calls
 * exactly like members (the product rule). The KIND rides along because
 * the recording routes are members-only (増分④ — routeIsMemberOnly).
 */
/** The verified subject for one dispatched trust domain (CRAP-budget split). */
function verifiedSubject(
  kind: 'member' | 'guest',
  token: string,
  env: Env,
): Promise<string | undefined> {
  return kind === 'member'
    ? verifiedMemberSubject(token, env.CLERK_ISSUER, env.CLERK_AUDIENCE)
    : verifiedGuestSubject(token, env.SPACETIME_HOST_URL);
}

async function verifiedCaller(
  authorization: string | null,
  env: Env,
): Promise<VerifiedCaller | undefined> {
  const token = bearerTokenFrom(authorization);
  if (token === undefined) return undefined;
  const kind = callerKindOf(unverifiedIssuerOf(token), env.CLERK_ISSUER);
  if (kind === undefined) return undefined;
  const subject = await verifiedSubject(kind, token, env);
  return subject === undefined ? undefined : { kind, subject };
}

/** Whether `route` may proceed for this caller, or the refusal to answer with. */
type CallerVerdict = { ok: true; caller: VerifiedCaller } | { ok: false; response: Response };

async function vetCaller(
  route: CallRoute,
  authorization: string | null,
  env: Env,
  cors: Record<string, string>,
): Promise<CallerVerdict> {
  const caller = await verifiedCaller(authorization, env);
  if (caller === undefined) {
    return { ok: false, response: json(401, { error: 'unauthorized' }, cors) };
  }
  // 録画の開始/停止・一覧・DL はメンバー限定 (増分④ 設計①): the guest
  // trust anchor proves an identity, not membership, so it never opens
  // the recording routes — the UI hiding its toggles stays cosmetic.
  if (routeIsMemberOnly(route) && caller.kind !== 'member') {
    return { ok: false, response: json(403, { error: 'members-only' }, cors) };
  }
  return { ok: true, caller };
}

/** Routes and authenticates one non-preflight request, mapping every failure. */
async function handleRouted(
  request: Request,
  env: Env,
  cors: Record<string, string>,
): Promise<Response> {
  const route = routeCallRequest(request.method, new URL(request.url).pathname);
  if (route === undefined) return json(404, { error: 'not-found' }, cors);
  const verdict = await vetCaller(route, request.headers.get('authorization'), env, cors);
  if (!verdict.ok) return verdict.response;
  try {
    const result = await handleCall(route, request, env, verdict.caller.subject);
    return json(result.status, result.body, cors);
  } catch (err) {
    // Provider details stay in Workers Logs (realtimekit.ts / r2.ts
    // already logged them); the browser gets an opaque failure.
    console.error('call API failure', err);
    return json(502, { error: 'provider-error' }, cors);
  }
}

/**
 * One RealtimeKit webhook delivery (増分④): authenticated by the
 * provider's signature over the raw body — no bearer, no CORS (it is
 * server-to-server). The verified event is logged for the operator
 * (recording.statusUpdate lifecycle; an ERRORED here is the recording
 * whose file will never appear in the bucket); relaying into SpacetimeDB
 * is deliberately deferred (see webhook.ts).
 */
/**
 * Logs one verified delivery's summary — never the raw payload, whose
 * UPLOADED form carries download URLs (the rules.ts summary is the whole
 * allowed surface). An ERRORED recording is the operator's signal: that
 * file will never appear in the bucket.
 */
function logWebhookSummary(summary: ReturnType<typeof summarizeRecordingEvent>): void {
  if (summary === null) {
    console.warn('webhook: unrecognized event shape');
    return;
  }
  if (summary.status === 'ERRORED') {
    console.error('recording errored', summary);
    return;
  }
  console.log('recording status', summary);
}

async function handleWebhook(request: Request): Promise<Response> {
  const body = await verifiedWebhookBody(request);
  if (body === undefined) return json(401, { error: 'unverified' }, {});
  try {
    logWebhookSummary(summarizeRecordingEvent(JSON.parse(new TextDecoder().decode(body))));
  } catch {
    return json(400, { error: 'malformed' }, {});
  }
  return new Response(null, { status: 200 });
}

/**
 * The preflight for the POSTs and authorized GETs (they carry
 * authorization + content-type). A disallowed origin gets a grant-less
 * 204 and the browser enforces the refusal.
 */
function preflightResponse(cors: Record<string, string>): Response {
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

/** Whether this is the provider's webhook delivery (no bearer, no CORS). */
function isWebhookDelivery(request: Request): boolean {
  return request.method === 'POST' && new URL(request.url).pathname === '/webhooks/realtimekit';
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (isWebhookDelivery(request)) return handleWebhook(request);
    const origin = allowedOrigin(request.headers.get('origin'), env.ALLOWED_ORIGINS);
    const cors: Record<string, string> =
      origin === undefined ? {} : { 'access-control-allow-origin': origin };
    if (request.method === 'OPTIONS') return preflightResponse(cors);
    return handleRouted(request, env, cors);
  },
};
