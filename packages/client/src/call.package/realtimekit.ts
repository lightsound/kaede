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
 * The track while its media is enabled, else undefined: the SDK keeps
 * stale track references around after a disable, and types some pairs as
 * always-present while handing back null/undefined members (a window
 * share has no audio track) — one rule, so every tile field reads the
 * same way.
 */
function liveTrack(
  enabled: boolean,
  track: MediaStreamTrack | null | undefined,
): MediaStreamTrack | undefined {
  return enabled ? (track ?? undefined) : undefined;
}

/**
 * Projects the SDK's live state into one CallSnapshot: the local
 * participant first, then everyone joined, tracks included only while the
 * matching media is enabled (liveTrack). Self audio is never projected —
 * playing back your own mic is feedback, and the mic state renders from
 * `micOn` instead. The same rule extends to the self screen-share's AUDIO
 * (a shared tab's sound is already playing in that tab); its video IS
 * projected, as the sharer's own confirmation of what everyone sees.
 */
function snapshotOf(meeting: Meeting): CallSnapshot {
  const self = meeting.self;
  const tiles: CallTile[] = [
    {
      key: 'self',
      name: self.name,
      isSelf: true,
      videoTrack: liveTrack(self.videoEnabled, self.videoTrack),
      audioTrack: undefined,
      screenTrack: liveTrack(self.screenShareEnabled, self.screenShareTracks.video),
      screenAudioTrack: undefined,
    },
    ...meeting.participants.joined.toArray().map((participant) => ({
      key: participant.id,
      name: participant.name,
      isSelf: false,
      videoTrack: liveTrack(participant.videoEnabled, participant.videoTrack),
      audioTrack: liveTrack(participant.audioEnabled, participant.audioTrack),
      screenTrack: liveTrack(participant.screenShareEnabled, participant.screenShareTracks.video),
      screenAudioTrack: liveTrack(
        participant.screenShareEnabled,
        participant.screenShareTracks.audio,
      ),
    })),
  ];
  return {
    tiles,
    micOn: self.audioEnabled,
    cameraOn: self.videoEnabled,
    screenShareOn: self.screenShareEnabled,
  };
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
    // Fires on the browser's own "stop sharing" bar too, not only the
    // dock's toggle — the snapshot re-projection handles both the same.
    meeting.self.on('screenShareUpdate', publish);
    const joined = meeting.participants.joined;
    joined.on('participantJoined', publish);
    joined.on('participantLeft', publish);
    joined.on('videoUpdate', publish);
    joined.on('audioUpdate', publish);
    joined.on('screenShareUpdate', publish);
    // Fires on every exit path — the own leave() below included — so the
    // dock resets through one signal whether the user left, was kicked, or
    // the meeting ended.
    meeting.self.on('roomLeft', onEnded);
    try {
      await meeting.join();
    } catch (err) {
      // A failed join must not leave the initialized client (listeners,
      // acquired devices) running with no session handle to release it
      // (a review finding); leave() is the SDK's teardown.
      await meeting.leave().catch(() => {});
      throw err;
    }
    publish();
    return {
      setMic: (on) => (on ? meeting.self.enableAudio() : meeting.self.disableAudio()),
      setCamera: (on) => (on ? meeting.self.enableVideo() : meeting.self.disableVideo()),
      // enableScreenShare opens the browser's picker; a cancelled picker
      // rejects, which the dock's toggle swallows like every media refusal.
      setScreenShare: (on) =>
        on ? meeting.self.enableScreenShare() : meeting.self.disableScreenShare(),
      leave: () => meeting.leave(),
    };
  },
};
