/**
 * 無操作(アイドル)時に接続を休止するための判定ロジック。
 *
 * 現行プロトコルは静止中でも入力バッチと行更新が流れ続けるため、開きっぱなしで
 * 忘れられたタブが Maincloud の従量エネルギーを消費し続ける(ROADMAP Phase 2 の
 * 「プロトコルのアイドル抑制」が本命の対策)。それまでの暫定ガードとして、
 * 一定時間ユーザー操作がなければクライアント側から接続を閉じ、次の操作で
 * 自動再接続する。判定は時刻を呼び出し側が注入する決定的なロジックとして
 * 切り出す(ユニットテストが実時間を待たずに済むように)。
 */

/**
 * この時間ユーザー操作がなければ接続を休止する。「アバターを置いて一緒に
 * 作業している感」(VISION)とはトレードオフなので、アイドル抑制の実装後に
 * 延長・撤廃を再検討する。
 */
export const IDLE_DISCONNECT_MS = 15 * 60_000;

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
   * 返し続ける(再開は activity だけが指示する)。
   */
  check(now: number): 'suspend' | 'none';
  /** 休止中かどうか。切断ハンドラが「意図した切断か」を見分けるのに使う。 */
  suspended(): boolean;
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
    suspended: () => suspended,
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
