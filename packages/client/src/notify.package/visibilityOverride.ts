/**
 * 開発ビルド限定の可視状態オーバーライド(例: /?visibility=hidden)。
 * ヘッドレスの Playwright では同一コンテキストで複数ページを開いて
 * bringToFront しても全ページが visible / focused のままになるため
 * (E2E スペック冒頭の実測メモ参照)、通知判定への入力(hidden / hasFocus)
 * だけを差し替えて「バックグラウンドのタブ」を作る。判定規則そのものは
 * @kaede/shared の shouldNotifyDm が単体テストで固定済みなので、ここで
 * 差し替えるのは環境の読み取りのみ(parseIdleTimeoutOverride の前例)。
 * 本番ビルドの呼び出し元は import.meta.env.DEV でこの関数ごと外す。
 */

export interface VisibilityReading {
  hidden: boolean;
  hasFocus: boolean;
}

export function parseVisibilityOverride(search: string): VisibilityReading | undefined {
  const raw = new URLSearchParams(search).get('visibility');
  return raw === 'hidden' ? { hidden: true, hasFocus: false } : undefined;
}
