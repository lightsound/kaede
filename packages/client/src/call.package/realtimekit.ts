// fallow-ignore-file coverage-gaps -- the dial half of the RealtimeKit seam: init + join over the vendor SDK, which needs live WebRTC infrastructure, not a unit test. The join rules live server-side in the join_group_call procedure (増分⑥), which mints the token dialed here

// The Core-SDK half of the vendor seam. Since 増分③ (the UI Kit adoption)
// the containment unit is the whole call.package, not this single file
// (VISION 決定ログ 2026-08-06): the meeting object flows to CallDock.tsx,
// which renders the vendor's prebuilt components around it. Nothing
// OUTSIDE call.package may import the vendor SDK or receive a Meeting —
// swapping providers (LiveKit ships the same-shaped prebuilt UI in
// @livekit/components-react) means rewriting this package and nothing else.
import RealtimeKitClient from '@cloudflare/realtimekit';
import { RealtimeKitNoiseCancellation } from '@cloudflare/realtimekit-noise-cancellation';

export type Meeting = Awaited<ReturnType<typeof RealtimeKitClient.init>>;

export type NoiseCanceller = RealtimeKitNoiseCancellation;

export interface DialRequest {
  authToken: string;
  onEnded(): void;
}

export interface DialResult {
  meeting: Meeting;
  /** Undefined when the noise canceller could not be initialized. */
  noiseCancellation: NoiseCanceller | undefined;
}

/**
 * Arms noise cancellation on the joined meeting (autoManage: the
 * package enables processing when the mic goes live, maintains it
 * through mute/unmute and reconnections, and disposes itself on leave).
 * Strictly best-effort — an enhancement must never fail a join: the
 * package self-disables on runtime errors, and an initialization
 * failure (an environment without AudioWorklet, the asset CDN
 * unreachable) just leaves the call without processing. The model and
 * worklet assets are fetched from the provider's CDN at enable time;
 * nothing is bundled or self-hosted.
 */
async function initNoiseCancellation(meeting: Meeting): Promise<NoiseCanceller | undefined> {
  try {
    return await RealtimeKitNoiseCancellation.init({
      meeting,
      autoManage: true,
      onError: (err) => console.error('noise cancellation error', err),
    });
  } catch (err) {
    console.error('noise cancellation init failed', err);
    return undefined;
  }
}

/**
 * Dials into the meeting: init with the minted token, join the room, hand
 * back the live meeting for the dock to render. Media starts OFF on both
 * sides — a call is entered listening, turning the camera and mic on is
 * the participant's explicit act (the same intentionality rule as
 * starting the call itself).
 */
export async function dialMeeting({ authToken, onEnded }: DialRequest): Promise<DialResult> {
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
  const noiseCancellation = await initNoiseCancellation(meeting);
  return { meeting, noiseCancellation };
}
