// fallow-ignore-file coverage-gaps -- the dial half of the RealtimeKit seam: init + join over the vendor SDK, which needs live WebRTC infrastructure, not a unit test. The join orchestration around it is flow.ts (unit-tested)

// The Core-SDK half of the vendor seam. Since 増分③ (the UI Kit adoption)
// the containment unit is the whole call.package, not this single file
// (VISION 決定ログ 2026-08-06): the meeting object flows to CallDock.tsx,
// which renders the vendor's prebuilt components around it. Nothing
// OUTSIDE call.package may import the vendor SDK or receive a Meeting —
// swapping providers (LiveKit ships the same-shaped prebuilt UI in
// @livekit/components-react) means rewriting this package and nothing else.
import RealtimeKitClient from '@cloudflare/realtimekit';

/** The SDK's meeting object, as Client.init returns it. */
export type Meeting = Awaited<ReturnType<typeof RealtimeKitClient.init>>;

/** What dialing needs, besides the token: the one exit signal. */
export interface DialRequest {
  /** The participant token the Worker minted (api.ts). */
  authToken: string;
  /** The session ended on any path (own leave, kicked, meeting ended). */
  onEnded(): void;
}

/**
 * Dials into the meeting: init with the minted token, join the room, hand
 * back the live meeting for the dock to render. Media starts OFF on both
 * sides — a call is entered listening, turning the camera and mic on is
 * the participant's explicit act (the same intentionality rule as
 * starting the call itself).
 */
export async function dialMeeting({ authToken, onEnded }: DialRequest): Promise<Meeting> {
  const meeting = await RealtimeKitClient.init({
    authToken,
    defaults: { audio: false, video: false },
  });
  // Fires on every exit path — the dock's own leave() included — so the
  // dock resets through one signal whether the user left, was kicked, or
  // the meeting ended.
  meeting.self.on('roomLeft', onEnded);
  try {
    await meeting.join();
  } catch (err) {
    // A failed join must not leave the initialized client (listeners,
    // acquired devices) running with no handle to release it (a review
    // finding); leave() is the SDK's teardown.
    await meeting.leave().catch(() => {});
    throw err;
  }
  return meeting;
}
