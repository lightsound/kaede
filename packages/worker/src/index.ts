// fallow-ignore-file coverage-gaps -- the Worker fetch wiring: CORS, auth dispatch and error mapping over live network calls; runs only inside workerd. Rules live in rules.ts (unit-tested); handlers/provider halves are handlers.ts / realtimekit.ts / webhook.ts / module.ts
// fallow-ignore-file unused-export unused-type -- the default export is the Worker entry workerd loads (nothing in this repo imports it), and Env is its bindings contract with infra/alchemy.run.ts / wrangler-call.jsonc

// kaede の通話 API Worker (ROADMAP Phase 4 増分①〜④) — thin stateless glue
// (VISION): RealtimeKit meeting/token/recording, webhook → reducer relay,
// R2 download. State lives in SpacetimeDB (group_call / call_recording).
import { verifiedMemberSubject } from './clerk';
import { type Caller, handleBrowserCall, handleRecordingWebhook } from './handlers';
import {
  allowedOrigin,
  bearerTokenFrom,
  callerKindOf,
  routeCallRequest,
  routeNeedsCaller,
  routeNeedsMember,
  unverifiedIssuerOf,
} from './rules';
import { verifiedGuestSubject } from './spacetime';
import { verifyRtkSignature } from './webhook';

/** The bindings infra/alchemy.run.ts declares for this Worker. */
export interface Env {
  REALTIMEKIT_API_TOKEN: string;
  REALTIMEKIT_APP_ID: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  CLERK_ISSUER: string;
  CLERK_AUDIENCE: string;
  SPACETIME_HOST_URL: string;
  ALLOWED_ORIGINS: string;
  SPACETIME_DB_NAME: string;
  CALL_SERVICE_SECRET: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_BUCKET_NAME: string;
  RECORDINGS: R2Bucket;
}

function json(status: number, body: unknown, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...cors },
  });
}

async function verifiedMemberCaller(token: string, env: Env): Promise<Caller | undefined> {
  const subject = await verifiedMemberSubject(token, env.CLERK_ISSUER, env.CLERK_AUDIENCE);
  return subject === undefined ? undefined : { subject, isMember: true };
}

async function verifiedGuestCaller(token: string, env: Env): Promise<Caller | undefined> {
  const subject = await verifiedGuestSubject(token, env.SPACETIME_HOST_URL);
  return subject === undefined ? undefined : { subject, isMember: false };
}

async function verifiedCaller(authorization: string | null, env: Env): Promise<Caller | undefined> {
  const token = bearerTokenFrom(authorization);
  if (token === undefined) return undefined;
  const kind = callerKindOf(unverifiedIssuerOf(token), env.CLERK_ISSUER);
  if (kind === 'member') return verifiedMemberCaller(token, env);
  if (kind === 'guest') return verifiedGuestCaller(token, env);
  return undefined;
}

async function handleWebhook(request: Request, env: Env): Promise<Response> {
  const raw = await request.arrayBuffer();
  if (!(await verifyRtkSignature(request.headers.get('rtk-signature'), raw))) {
    return json(401, { error: 'unauthorized' }, {});
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return json(400, { error: 'bad-json' }, {});
  }
  try {
    await handleRecordingWebhook(env, parsed);
  } catch (err) {
    console.error('webhook handling failed', err);
    return json(502, { error: 'relay-error' }, {});
  }
  return new Response(null, { status: 204 });
}

function withCors(response: Response, origin: string | undefined): Response {
  if (origin === undefined) return response;
  const headers = new Headers(response.headers);
  headers.set('access-control-allow-origin', origin);
  return new Response(response.body, { status: response.status, headers });
}

function corsHeaders(origin: string | undefined): Record<string, string> {
  return origin === undefined ? {} : { 'access-control-allow-origin': origin };
}

function optionsResponse(cors: Record<string, string>): Response {
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

async function dispatchBrowserCall(
  route: NonNullable<ReturnType<typeof routeCallRequest>>,
  request: Request,
  env: Env,
  caller: Caller,
  origin: string | undefined,
  cors: Record<string, string>,
): Promise<Response> {
  if (routeNeedsMember(route) && !caller.isMember) {
    return json(403, { error: 'forbidden' }, cors);
  }
  try {
    const response = await handleBrowserCall(
      route,
      request,
      {
        accountId: env.CLOUDFLARE_ACCOUNT_ID,
        appId: env.REALTIMEKIT_APP_ID,
        apiToken: env.REALTIMEKIT_API_TOKEN,
      },
      {
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
        bucket: env.R2_BUCKET_NAME,
        accountId: env.CLOUDFLARE_ACCOUNT_ID,
      },
      env,
      caller,
    );
    return withCors(response, origin);
  } catch (err) {
    console.error('call API failure', err);
    return json(502, { error: 'provider-error' }, cors);
  }
}

async function handleAuthenticatedRoute(
  route: NonNullable<ReturnType<typeof routeCallRequest>>,
  request: Request,
  env: Env,
  origin: string | undefined,
  cors: Record<string, string>,
): Promise<Response> {
  if (!routeNeedsCaller(route)) return json(404, { error: 'not-found' }, cors);
  const caller = await verifiedCaller(request.headers.get('authorization'), env);
  if (caller === undefined) return json(401, { error: 'unauthorized' }, cors);
  return dispatchBrowserCall(route, request, env, caller, origin, cors);
}

async function handleRoutedRequest(
  request: Request,
  env: Env,
  origin: string | undefined,
  cors: Record<string, string>,
): Promise<Response> {
  const route = routeCallRequest(request.method, new URL(request.url).pathname);
  if (route === undefined) return json(404, { error: 'not-found' }, cors);
  if (route.kind === 'webhook') return handleWebhook(request, env);
  return handleAuthenticatedRoute(route, request, env, origin, cors);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = allowedOrigin(request.headers.get('origin'), env.ALLOWED_ORIGINS);
    const cors = corsHeaders(origin);
    if (request.method === 'OPTIONS') return optionsResponse(cors);
    return handleRoutedRequest(request, env, origin, cors);
  },
};
