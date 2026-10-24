/**
 * 会話グループ単位の通話 (ROADMAP Phase 4 増分①) — a conversation group's
 * call is one `group_call` row: groupId → the call provider's meeting id
 * (the reusable room the CallProvider joins). Since 増分⑥ the
 * join_group_call procedure provisions the meeting, binds the row and
 * mints the participant token in one place (the server's calls.ts); the
 * meeting id stays the read-side JOIN CAPABILITY, which is why the row
 * rides a members-only RLS filter (see groupCallVisibility in the
 * server's tables.ts). These are the shared rules of the call and
 * recording procedures, which stay thin untestable wrappers (the huddle
 * precedent).
 */

/**
 * Whether `fileName` has the shape the provider names recording files —
 * `{meetingId}_{epochMillis}.mp4`, fixed at start time as the Start
 * Recording response's `output_file_name` (live-probed 2026-08-06, ROADMAP
 * Phase 4 増分④). Two places rule on it: the R2 listing parse
 * (parseBucketListing) skips objects not shaped like a recording, and the
 * recording_download_url procedure refuses a client-claimed name before
 * signing it into an R2 object key (where the shape rule is also what
 * makes prefix escapes — slashes, dots — unrepresentable). The epoch width
 * is lenient (10–17 digits) because nothing rules on its value, only on
 * the overall shape.
 */
export function isRecordingFileNameLike(fileName: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_\d{10,17}\.mp4$/.test(
    fileName,
  );
}

/**
 * How many call_recording rows the module retains (the CHAT_HISTORY_MAX
 * shape: trimmed by the writer on every insert). These rows are LABELS for
 * the R2 listing, not the recordings themselves — a trimmed row degrades
 * its object to a date-only listing entry, deletes nothing — so the cap
 * only bounds what every entering client downloads with the public table.
 * 200 recordings is years of the community's meeting cadence.
 */
export const RECORDING_HISTORY_MAX = 200;

/**
 * The call procedures' token bucket parameters (the huddle numbers, one
 * bucket shared by join_group_call and the recording procedures — the same
 * UI flow's low-frequency operations, with no client-side mirror to drift
 * from). The evaluator wrapper lives server-side (chargeCallAllowance in
 * calls.ts), for the HUDDLE_SEND_COST_MICROS reason: a shared wrapper
 * would add type-coupling edges past the evidence cap.
 */
export const CALL_SEND_COST_MICROS = 1_000_000n;
export const CALL_BURST_SENDS = 5;
