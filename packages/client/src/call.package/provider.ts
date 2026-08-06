// fallow-ignore-file coverage-gaps -- type declarations only (the CallProvider seam); the behavior behind them lives in realtimekit.ts and the flow rules in flow.ts (unit-tested)
// The provider-neutral call vocabulary (VISION: RealtimeKit への直接依存を
// CallProvider アダプタ 1 モジュールに閉じ込める). Everything outside
// realtimekit.ts — the dock, the flow, App — speaks THESE types only;
// swapping providers (LiveKit etc.) means implementing CallProvider once
// and touching nothing else in the client.

/** One rendered participant: a tile in the call dock. */
export interface CallTile {
  /** The provider's participant id — the React key, opaque otherwise. */
  key: string;
  /** The display name the participant joined under. */
  name: string;
  /** Whether this tile is the local participant (rendered muted/mirrored). */
  isSelf: boolean;
  /** The live camera track while the participant's camera is on. */
  videoTrack: MediaStreamTrack | undefined;
  /** The live mic track while unmuted — undefined for self (never played back). */
  audioTrack: MediaStreamTrack | undefined;
  /** The live screen-share video while the participant is sharing (増分②). */
  screenTrack: MediaStreamTrack | undefined;
  /** The shared tab/window audio, when the share carries any — undefined for self. */
  screenAudioTrack: MediaStreamTrack | undefined;
}

/** The whole visible state of the ongoing call, re-published on every change. */
export interface CallSnapshot {
  tiles: CallTile[];
  micOn: boolean;
  cameraOn: boolean;
  screenShareOn: boolean;
}

/** The handle on one joined call. */
export interface CallSession {
  setMic(on: boolean): Promise<void>;
  setCamera(on: boolean): Promise<void>;
  setScreenShare(on: boolean): Promise<void>;
  leave(): Promise<void>;
}

/** What joining a call needs, besides the token: the dock's callbacks. */
export interface CallJoinRequest {
  /** The participant token the Worker minted (api.ts). */
  authToken: string;
  /** Every visible change of the call, self and remote alike. */
  onSnapshot(snapshot: CallSnapshot): void;
  /** The session ended from the provider's side (kicked, meeting ended). */
  onEnded(): void;
}

/** The one seam a call provider implements (realtimekit.ts today). */
export interface CallProvider {
  join(request: CallJoinRequest): Promise<CallSession>;
}
