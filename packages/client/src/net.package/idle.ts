/**
 * 無操作(アイドル)時に接続を休止するための判定ロジック。
 *
 * プロトコルのアイドル抑制(sendGate.ts)実装後の位置づけ: 静止中の送信は
 * ゲートが 0 にし(残るのは3分毎のハートビートだけ)、このガードが守るのは
 * 受信側 — 接続している限り他プレイヤーの行更新の egress を受け続ける —
 * と、忘れられたタブの接続そのもの。判定は時刻を呼び出し側が注入する
 * 決定的なロジックとして切り出す(ユニットテストが実時間を待たずに済む
 * ように)。
 */

/**
 * この時間ユーザー操作がなければ接続を休止する。アイドル抑制の実装
 * (2026-08-02)に伴い 15分 → 60分 へ延長した。理由: ①休止が守るコストは
 * 受信 egress だけになり、バッチ間隔延長後は 1タブあたり高々数MB/時と
 * 小さい ②「タブを開いたまま別ウィンドウで作業する」というメイン用途では
 * kaede タブに操作イベントが発生せず、15分では在席表示(VISION の
 * 「アバターを置いて一緒に作業している感」)が切れすぎる。撤廃しないのは
 * 夜間・週末の忘れタブが受信を垂れ流し続けるのを止めるため。
 */
export const IDLE_DISCONNECT_MS = 60 * 60_000;

/**
 * 休止判定の周期。バックグラウンドタブではブラウザがタイマーを間引くため
 * 実際の周期はこれより粗くなる(分単位)が、休止が多少遅れるだけで害はない。
 */
export const IDLE_CHECK_INTERVAL_MS = 1000;

export interface IdleMonitor {
  /**
   * ユーザー操作を記録する。休止中に呼ばれたら 'resume'(再接続せよ)を返し、
   * 監視は稼働状態に戻る。'none' は何もしない。
   */
  activity(now: number): 'resume' | 'none';
  /**
   * 周期チェック。最後の操作からタイムアウト以上経っていれば 'suspend'
   * (接続を休止せよ)を返し、監視は休止状態に入る。休止中は 'none' を
   * 返し続ける(再開は activity だけが指示する)。「休止中かどうか」を
   * 接続側の判断に使うときは、この監視ではなくライフサイクル状態機械
   * (lifecycle.ts の suspended)を見る — 真実は一箇所に置く。
   */
  check(now: number): 'suspend' | 'none';
}

export function createIdleMonitor(timeoutMs: number, now: number): IdleMonitor {
  let lastActivityAt = now;
  let suspended = false;
  return {
    activity(now) {
      lastActivityAt = now;
      if (!suspended) return 'none';
      suspended = false;
      return 'resume';
    },
    check(now) {
      if (suspended || now - lastActivityAt < timeoutMs) return 'none';
      suspended = true;
      return 'suspend';
    },
  };
}

/**
 * 開発ビルド限定のタイムアウト上書き(例: /?idleMs=3000)。E2E テストと
 * 手動確認が 15 分待たずに休止を検証するためのもので、本番ビルドの呼び出し元は
 * import.meta.env.DEV でこの関数ごと外す。正の有限数だけを受け付ける。
 */
export function parseIdleTimeoutOverride(search: string): number | undefined {
  const raw = new URLSearchParams(search).get('idleMs');
  if (raw === null || raw.trim() === '') return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
