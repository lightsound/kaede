// fallow-ignore-file coverage-gaps -- the Worker fetch wiring: routes, CORS and error mapping over live network calls; runs only inside workerd. Every rule worth testing is in rules.ts (unit-tested); the network halves are clerk.ts / realtimekit.ts
// fallow-ignore-file unused-export unused-type -- the default export is the Worker entry workerd loads (nothing in this repo imports it), and Env is its bindings contract with infra/alchemy.run.ts / wrangler-call.jsonc

// kaede の通話 API Worker (ROADMAP Phase 4 増分①) — the first of the thin
// stateless glue Workers VISION limits the backend to: it exists ONLY
// because RealtimeKit calls need a secret the browser must never hold
// (and SpacetimeDB modules cannot call external HTTP). It keeps no state:
// which group has which meeting lives in SpacetimeDB (group_call), and
// who may join is enforced there too (the members-only RLS filter) — this
// Worker only checks "a signed-in member of the space is asking"
// (clerk.ts) and forwards to the provider (realtimekit.ts).
//
// Deployed by infra/alchemy.run.ts (Worker `kaede-call`); the wrangler
// escape hatch is infra/wrangler-call.jsonc. Local dev runs `wrangler dev`
// against the same entry with .dev.vars — see README「通話 API Worker」.
import { verifiedMemberSubject } from './clerk';
import { createMeeting, mintParticipantToken } from './realtimekit';
import { allowedOrigin, participantNameFrom, routeCallRequest } from './rules';

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
  /** Comma-separated browser origins allowed to call this API. */
  ALLOWED_ORIGINS: string;
}

function json(status: number, body: unknown, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...cors },
  });
}

/** Dispatches one authenticated, routed request to the provider. */
async function handleCall(
  route: NonNullable<ReturnType<typeof routeCallRequest>>,
  request: Request,
  env: Env,
  subject: string,
): Promise<{ status: number; body: unknown }> {
  const cfg = {
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    appId: env.REALTIMEKIT_APP_ID,
    apiToken: env.REALTIMEKIT_API_TOKEN,
  };
  if (route.kind === 'provision') {
    return { status: 201, body: { meetingId: await createMeeting(cfg) } };
  }
  const body: unknown = await request.json().catch(() => undefined);
  const name = participantNameFrom(body);
  return {
    status: 201,
    body: { authToken: await mintParticipantToken(cfg, route.meetingId, name, subject) },
  };
}

/** Routes and authenticates one non-preflight request, mapping every failure. */
async function handleRouted(
  request: Request,
  env: Env,
  cors: Record<string, string>,
): Promise<Response> {
  const route = routeCallRequest(request.method, new URL(request.url).pathname);
  if (route === undefined) return json(404, { error: 'not-found' }, cors);
  const subject = await verifiedMemberSubject(
    request.headers.get('authorization'),
    env.CLERK_ISSUER,
    env.CLERK_AUDIENCE,
  );
  if (subject === undefined) return json(401, { error: 'unauthorized' }, cors);
  try {
    const result = await handleCall(route, request, env, subject);
    return json(result.status, result.body, cors);
  } catch (err) {
    // Provider details stay in Workers Logs (realtimekit.ts already
    // logged them); the browser gets an opaque failure.
    console.error('call API failure', err);
    return json(502, { error: 'provider-error' }, cors);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = allowedOrigin(request.headers.get('origin'), env.ALLOWED_ORIGINS);
    const cors: Record<string, string> =
      origin === undefined ? {} : { 'access-control-allow-origin': origin };
    if (request.method === 'OPTIONS') {
      // The preflight for the POSTs (they carry authorization +
      // content-type). A disallowed origin gets a grant-less 204 and the
      // browser enforces the refusal.
      return new Response(null, {
        status: 204,
        headers: {
          ...cors,
          'access-control-allow-methods': 'POST, OPTIONS',
          'access-control-allow-headers': 'authorization, content-type',
          'access-control-max-age': '86400',
        },
      });
    }
    return handleRouted(request, env, cors);
  },
};
