// The noise-cancellation toggle's face logic (vendor package:
// @cloudflare/realtimekit-noise-cancellation, wired in realtimekit.ts).
// Pure, so unit-tested; the panel component itself needs a DOM and
// WebRTC and stays untested like the rest of InCallPanel.

/**
 * What the noise-cancellation toggle shows, following the recording
 * toggle's convention (InCallPanel's toggleFace): the label names the
 * ACTION a click performs, and while a click is in flight the button
 * disables under a transitional face instead of silently greying out —
 * enable/disable round-trips the provider's audio middleware, so the
 * gap is visible time, not breakage.
 */
export function noiseCancellationFace(
  enabled: boolean,
  pending: boolean,
): { label: string; disabled: boolean } {
  if (pending) return { label: '⏳ 処理中…', disabled: true };
  return enabled
    ? { label: 'ノイズ除去をオフにする', disabled: false }
    : { label: 'ノイズ除去をオンにする', disabled: false };
}
