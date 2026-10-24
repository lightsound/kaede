// fallow-ignore-file coverage-gaps -- registers window and document listeners and an interval; needs a browser page. The decisions they feed are pure and unit-tested: the idle monitor (idle.ts) and the lifecycle transitions (lifecycle.ts)
import {
  createIdleMonitor,
  IDLE_CHECK_INTERVAL_MS,
  IDLE_DISCONNECT_MS,
  type IdleMonitor,
  parseIdleTimeoutOverride,
} from './idle';
import type { LifecycleEvent } from './lifecycle';

/** ユーザーの在席とみなす操作イベント。タイムスタンプを書くだけなので capture+passive で広く拾う。 */
const ACTIVITY_EVENTS = ['keydown', 'pointerdown', 'pointermove', 'wheel'] as const;

/** What the activity signals drive in the net stack that owns them (startNet). */
export interface ActivityHooks {
  /** True once the stack is torn down: every signal is ignored from then on. */
  isDisposed(): boolean;
  /** Runs one lifecycle step — only the three this module raises. */
  dispatch(
    event: Extract<LifecycleEvent, { kind: 'resume' | 'page-resume' | 'idle-timeout' }>,
  ): void;
}

/**
 * Records every user input in the idle monitor (the clock watchIdleTimeout
 * checks) and resumes an idle-suspended connection on it; returns the
 * teardown.
 */
function watchUserInput(idle: IdleMonitor, hooks: ActivityHooks): () => void {
  const onActivity = (): void => {
    if (hooks.isDisposed()) return;
    if (idle.activity(Date.now()) !== 'resume') return;
    console.info('SpacetimeDB: user input detected, resuming the connection');
    hooks.dispatch({ kind: 'resume' });
  };
  for (const type of ACTIVITY_EVENTS) {
    window.addEventListener(type, onActivity, { capture: true, passive: true });
  }
  return () => {
    for (const type of ACTIVITY_EVENTS) {
      window.removeEventListener(type, onActivity, { capture: true });
    }
  };
}

/**
 * ページ復帰の自動回復(lifecycle.ts の page-resume 節を参照): 背景タブで
 * 停滞した再試行の前倒しと、凍結中に onclose が届かないまま死んだソケット
 * (ゾンビ)の検出・再構築。SDK 2.7.1 の ConnectionManager と同じイベント
 * 群を購読する — visibilitychange は非表示→表示、focus は同一表示状態での
 * ウィンドウ切替、online はネットワーク復旧、pageshow は bfcache 復元
 * (visibilitychange が発火しないことがある)をそれぞれ拾う。
 */
function watchPageResume(hooks: ActivityHooks): () => void {
  const onPageResume = (): void => {
    if (hooks.isDisposed()) return;
    hooks.dispatch({ kind: 'page-resume' });
  };
  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'visible') onPageResume();
  };
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('focus', onPageResume);
  window.addEventListener('online', onPageResume);
  window.addEventListener('pageshow', onPageResume);
  return () => {
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('focus', onPageResume);
    window.removeEventListener('online', onPageResume);
    window.removeEventListener('pageshow', onPageResume);
  };
}

/** Suspends the connection after the idle timeout without user input; returns the teardown. */
function watchIdleTimeout(
  idle: IdleMonitor,
  idleTimeoutMs: number,
  hooks: ActivityHooks,
): () => void {
  const idleTimer = setInterval(() => {
    if (hooks.isDisposed()) return;
    if (idle.check(Date.now()) !== 'suspend') return;
    console.info(
      `SpacetimeDB: no user input for ${idleTimeoutMs}ms, suspending the connection (input resumes it)`,
    );
    hooks.dispatch({ kind: 'idle-timeout' });
  }, IDLE_CHECK_INTERVAL_MS);
  return () => clearInterval(idleTimer);
}

/**
 * Watches what the user and the page do, for the connection lifecycle:
 * user input, the idle timeout and page resume. Returns the teardown,
 * which removes every listener and the timer.
 */
export function watchActivity(hooks: ActivityHooks): () => void {
  // 無操作ガード: タイムアウトを超えたら接続(と再試行ループ)を休止し、次の
  // 操作で再開する。開発ビルドだけ ?idleMs= で短縮できる(E2E・手動確認用)。
  const idleTimeoutMs =
    (import.meta.env.DEV ? parseIdleTimeoutOverride(window.location.search) : undefined) ??
    IDLE_DISCONNECT_MS;
  const idle = createIdleMonitor(idleTimeoutMs, Date.now());
  const stopUserInput = watchUserInput(idle, hooks);
  const stopPageResume = watchPageResume(hooks);
  const stopIdleTimeout = watchIdleTimeout(idle, idleTimeoutMs, hooks);
  return () => {
    stopIdleTimeout();
    stopUserInput();
    stopPageResume();
  };
}
