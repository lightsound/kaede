// fallow-ignore-file coverage-gaps -- thin fetch wrappers over the RealtimeKit REST API; they need the live provider, not a unit test (scripts/spike-realtimekit.sh is their standing manual probe). The request-level rules live in rules.ts and are unit-tested

// The provider half of the call API (ROADMAP Phase 4 増分①): the ONLY
// place kaede's server side talks to RealtimeKit. The client-side
// counterpart is packages/client's call.package (the CallProvider
// adapter); between them, swapping providers (LiveKit etc. — VISION) is
// these two modules plus the infra bindings, nothing else.
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

async function providerPost(cfg: ProviderConfig, path: string, body: unknown): Promise<unknown> {
  const base = `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/realtime/kit`;
  // fallow-ignore-next-line security-sink -- the host is the Cloudflare API literal; accountId/appId are deploy-time bindings (infra/alchemy.run.ts), and the only request-derived segment is a meeting id vetted to UUID shape by routeCallRequest
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${cfg.apiToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
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
  const data = await providerPost(cfg, `/${cfg.appId}/meetings`, { title: 'kaede 通話' });
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
  const data = await providerPost(cfg, `/${cfg.appId}/meetings/${meetingId}/participants`, {
    name,
    preset_name: PARTICIPANT_PRESET,
    custom_participant_id: participantId,
  });
  return stringField(data, 'token');
}
