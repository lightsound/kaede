/**
 * Returns the world Container offset that centers (focusX, focusY) in a
 * viewport of view*, clamped so the camera never shows past the world edges.
 * A world smaller than the viewport (a compact map on a wide window, now
 * that the viewport follows the window size) sits centered instead of
 * pinned to an edge.
 */
export function cameraOffset(
  focusX: number,
  focusY: number,
  viewW: number,
  viewH: number,
  worldW: number,
  worldH: number,
): { x: number; y: number } {
  return {
    x: offsetAxis(focusX, viewW, worldW),
    y: offsetAxis(focusY, viewH, worldH),
  };
}

function offsetAxis(focus: number, view: number, world: number): number {
  if (world <= view) return (view - world) / 2;
  return -clamp(focus - view / 2, 0, world - view);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * 開発ビルド限定のカメラ倍率上書き(例: /?zoom=2)。検品・デモ録画で
 * アバターを画面上大きく映すためのもので、縦フィット描画(ワールド全高 =
 * ウィンドウ高)では他に拡大手段がない。呼び出し元(GameApp)が
 * import.meta.env.DEV で外すので本番バンドルには乗らない。1〜8 の有限数
 * だけを受け付ける(0 以下・巨大値は描画を壊すため)。
 */
export function parseZoomOverride(search: string): number | undefined {
  const raw = new URLSearchParams(search).get('zoom');
  if (raw === null || raw.trim() === '') return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 8 ? parsed : undefined;
}
