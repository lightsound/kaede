export function noiseCancellationFace(
  enabled: boolean,
  pending: boolean,
): { label: string; disabled: boolean } {
  if (pending) return { label: '⏳ 処理中…', disabled: true };
  return enabled
    ? { label: 'ノイズ除去をオフにする', disabled: false }
    : { label: 'ノイズ除去をオンにする', disabled: false };
}
