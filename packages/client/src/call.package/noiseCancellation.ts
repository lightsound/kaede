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

export type NoiseCancellationAction = 'enable' | 'disable' | 'none';

export function noiseCancellationAction(
  wanted: boolean,
  enabled: boolean,
  micLive: boolean,
): NoiseCancellationAction {
  if (!micLive || wanted === enabled) return 'none';
  return wanted ? 'enable' : 'disable';
}
