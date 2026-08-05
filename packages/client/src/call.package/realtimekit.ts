// fallow-ignore-file coverage-gaps -- the RealtimeKit implementation of CallProvider: a thin event-to-snapshot wrapper over the vendor SDK, which needs live WebRTC infrastructure, not a unit test

// THE RealtimeKit module (VISION: 直接依存を 1 モジュールに閉じ込める) —
// the only file in the client that imports the vendor SDK. Everything it
// hands out is the provider-neutral vocabulary of provider.ts; the server
// counterpart (the other half of the provider seam) is
// packages/worker/src/realtimekit.ts.
import RealtimeKitClient from '@cloudflare/realtimekit';
import type { CallProvider, CallSnapshot, CallTile } from './provider';

/** The SDK's meeting object, as Client.init returns it. */
type Meeting = Awaited<ReturnType<typeof RealtimeKitClient.init>>;

/**
 * Projects the SDK's live state into one CallSnapshot: the local
 * participant first, then everyone joined, tracks included only while the
 * matching media is enabled (the SDK keeps stale track references around
 * after a disable). Self audio is never projected — playing back your own
 * mic is feedback, and the mic state renders from `micOn` instead.
 */
function snapshotOf(meeting: Meeting): CallSnapshot {
  const self = meeting.self;
  const tiles: CallTile[] = [
    {
      key: 'self',
      name: self.name,
      isSelf: true,
      videoTrack: self.videoEnabled ? self.videoTrack : undefined,
      audioTrack: undefined,
    },
    ...meeting.participants.joined.toArray().map((participant) => ({
      key: participant.id,
      name: participant.name,
      isSelf: false,
      videoTrack: participant.videoEnabled ? participant.videoTrack : undefined,
      audioTrack: participant.audioEnabled ? participant.audioTrack : undefined,
    })),
  ];
  return { tiles, micOn: self.audioEnabled, cameraOn: self.videoEnabled };
}

/**
 * The RealtimeKit CallProvider: init with the minted token, join the room,
 * and re-publish a snapshot on every visible change. Media starts OFF on
 * both sides (defaults audio/video false) — a call is entered listening,
 * turning the camera and mic on is the participant's explicit act (the
 * same intentionality rule as starting the call itself).
 */
export const realtimeKitProvider: CallProvider = {
  async join({ authToken, onSnapshot, onEnded }) {
    const meeting = await RealtimeKitClient.init({
      authToken,
      defaults: { audio: false, video: false },
    });
    const publish = (): void => onSnapshot(snapshotOf(meeting));
    meeting.self.on('videoUpdate', publish);
    meeting.self.on('audioUpdate', publish);
    const joined = meeting.participants.joined;
    joined.on('participantJoined', publish);
    joined.on('participantLeft', publish);
    joined.on('videoUpdate', publish);
    joined.on('audioUpdate', publish);
    // Fires on every exit path — the own leave() below included — so the
    // dock resets through one signal whether the user left, was kicked, or
    // the meeting ended.
    meeting.self.on('roomLeft', onEnded);
    await meeting.join();
    publish();
    return {
      setMic: (on) => (on ? meeting.self.enableAudio() : meeting.self.disableAudio()),
      setCamera: (on) => (on ? meeting.self.enableVideo() : meeting.self.disableVideo()),
      leave: () => meeting.leave(),
    };
  },
};
