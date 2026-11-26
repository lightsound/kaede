export function noiseCancellationFace(
  wanted: boolean,
  micLive: boolean,
  pending: boolean,
): { label: string; disabled: boolean } {
  if (pending) return { label: '⏳ 処理中…', disabled: true };
  return {
    label: wanted ? 'ノイズ除去をオフにする' : 'ノイズ除去をオンにする',
    disabled: !micLive,
  };
}

export interface NoiseCancellationMic {
  audioEnabled: boolean;
  rawAudioTrack: { readyState: string; enabled: boolean } | undefined;
}

export function noiseCancellationMicLive(mic: NoiseCancellationMic): boolean {
  const track = mic.rawAudioTrack;
  return mic.audioEnabled && track !== undefined && track.readyState === 'live' && track.enabled;
}

export type NoiseCancellationAction = 'enable' | 'disable' | 'none';

export function noiseCancellationAction(
  wanted: boolean,
  enabled: boolean,
  micLive: boolean,
): NoiseCancellationAction {
  if (!micLive || wanted === enabled) return 'none';
  return wanted ? 'enable' : 'disable';
}
