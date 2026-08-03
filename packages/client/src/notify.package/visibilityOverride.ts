/**
 * 開発ビルド限定の可視状態オーバーライド(例: /?visibility=hidden)。
 * ヘッドレスの Playwright では同一コンテキストで複数ページを開いて
 * bringToFront しても全ページが visible / focused のままになるため
 * (E2E スペック冒頭の実測メモ参照)、通知判定への入力(hidden / hasFocus)
 * だけを差し替えて「バックグラウンドのタブ」を作る。判定規則そのものは
 * @maple/shared の shouldNotifyDm が単体テストで固定済みなので、ここで
 * 差し替えるのは環境の読み取りのみ(parseIdleTimeoutOverride の前例)。
 * 本番ビルドの呼び出し元は import.meta.env.DEV でこの関数ごと外す。
 */

/** document.hidden / document.hasFocus() の読み替え値。 */
export interface VisibilityReading {
  hidden: boolean;
  hasFocus: boolean;
}

/**
 * `?visibility=hidden` だけを受け付ける(タブ切替・最小化と同じ読み)。
 * それ以外の値は上書きなし — 素の document を読む。
 */
export function parseVisibilityOverride(search: string): VisibilityReading | undefined {
  const raw = new URLSearchParams(search).get('visibility');
  return raw === 'hidden' ? { hidden: true, hasFocus: false } : undefined;
}
