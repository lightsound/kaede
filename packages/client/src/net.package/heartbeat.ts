// fallow-ignore-file coverage-gaps -- spawns a real Web Worker; the decision of WHEN a heartbeat is due lives in sync.ts against HEARTBEAT_INTERVAL_MS, and what the server does with one is evaluateInputBatch, unit-tested in @maple/shared
/**
 * 静止中の生存証明(ハートビート)を予定するタイマー。
 *
 * メインスレッドの setInterval は使えない: バックグラウンドタブでは
 * ブラウザがタイマーを間引き、Chrome の intensive throttling では約1回/時
 * まで落ちる。kaede の主用途は「タブを開いたまま別の作業をする」なので、
 * それではハートビートが OFFLINE_RETENTION_MS に間に合わず、接続したままの
 * プレイヤーが掃除→再join→スポーン地点テレポートを繰り返す(rAF 停止で
 * 入力バッチも止まるため、抑制以前から背景タブはこの穴があった)。
 * 専用 Web Worker のタイマーはこの間引きの対象外なので、tick だけ Worker で
 * 刻み、本体(送るかどうか・何を送るか)はメインスレッド側で判断する。
 */
import { HEARTBEAT_CHECK_INTERVAL_MS } from '@maple/shared';

export interface Heartbeat {
  dispose(): void;
}

/**
 * Calls `onCheck` every HEARTBEAT_CHECK_INTERVAL_MS from a dedicated worker.
 * The callback decides whether a heartbeat is actually due (the worst-case
 * send interval is HEARTBEAT_INTERVAL_MS plus this check granularity — the
 * sweep-margin invariant in guard.test.ts accounts for both).
 */
export function createHeartbeat(onCheck: () => void): Heartbeat {
  // An inline (blob) worker: the script is one setInterval, so a separate
  // bundled file would be pure overhead. The URL can be revoked as soon as
  // the Worker is constructed — creation dereferences it synchronously.
  const src = `setInterval(() => postMessage(0), ${HEARTBEAT_CHECK_INTERVAL_MS});`;
  const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
  const worker = new Worker(url);
  URL.revokeObjectURL(url);
  worker.onmessage = onCheck;
  return { dispose: () => worker.terminate() };
}
