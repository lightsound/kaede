// fallow-ignore-file coverage-gaps -- thin HTTP wrappers that call SpacetimeDB reducers on the live host; the catalog rules they feed live in packages/server (calls.ts) and @kaede/shared

// Worker → SpacetimeDB reducer relay (ROADMAP Phase 4 増分④ / VISION
// 「Webhook→リデューサー中継」). The Worker stays stateless: it presents
// the shared CALL_SERVICE_SECRET and the host's anonymous-or-token call
// endpoint invokes upsert_call_recording_status. Auth for the HTTP call
// itself is optional (SpacetimeDB allocates an anonymous identity); the
// reducer refuses unless the secret matches the private
// call_service_secret row.

export interface ModuleConfig {
  hostUrl: string;
  database: string;
  serviceSecret: string;
}

export interface RecordingStatusUpsert {
  recordingId: string;
  meetingId: string;
  status: string;
  objectKey: string;
  outputFileName: string;
  startedAtMs: bigint;
  durationSecs: number;
}

/**
 * Calls upsert_call_recording_status on the module. Throws on non-2xx so
 * the webhook handler can 5xx and let RealtimeKit retry.
 */
export async function upsertRecordingStatus(
  cfg: ModuleConfig,
  fields: RecordingStatusUpsert,
): Promise<void> {
  const url = `${cfg.hostUrl.replace(/\/$/, '')}/v1/database/${cfg.database}/call/upsert_call_recording_status`;
  // fallow-ignore-next-line security-sink -- hostUrl/database are deploy-time bindings; the reducer name is a literal
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // SpacetimeDB HTTP call body: JSON array of the reducer's argument
    // product (one element — the named args object).
    body: JSON.stringify([
      {
        secret: cfg.serviceSecret,
        recordingId: fields.recordingId,
        meetingId: fields.meetingId,
        status: fields.status,
        objectKey: fields.objectKey,
        outputFileName: fields.outputFileName,
        startedAtMs: fields.startedAtMs.toString(),
        durationSecs: fields.durationSecs,
      },
    ]),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    console.error('module upsert_call_recording_status failed', response.status, text);
    throw new Error(`module upsert failed (${response.status})`);
  }
}
