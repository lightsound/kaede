/**
 * 接続ライフサイクル(再試行・アイドル休止・世代管理)の純粋な状態遷移関数。
 *
 * sync.ts はこの transition が返した効果(エフェクト)を実行するだけの薄い
 * シェルになる: タイマー・ソケット・ステータス通知という副作用はすべて
 * エフェクトとして宣言され、「いつ何をしてよいか」の判断はここに閉じる。
 * 切り出しの動機は2つ(ROADMAP Phase 2):
 * ① 再試行・休止・世代のからみ合う規則を実時間なしで単体テストできること。
 * ② 変化点駆動プロトコルへ将来エスカレーションする場合、接続状態機械が
 *    純関数として独立していれば送信規則の差し替えがシェルに閉じること。
 *
 * 設計の要点は sync.ts 時代のコメントを引き継ぐ:
 * - 再試行は失敗ごとに1回だけ武装する(接続失敗は reject と socket close の
 *   両方を報告するため、armed チェックなしでは backoff が二重に倍加した)。
 * - 休止(suspended)中は何も再武装しない。復帰はユーザー入力(resume)だけ。
 * - 世代(generation)は「どの connect が現行か」。ソケットは非同期に閉じる
 *   ため、切断報告や行イベントは新しい接続が確立した後にも届く。古い世代の
 *   イベントは stale として無視する。休止が LIVE セッションを切るときは
 *   世代を進めて即座に stale 化する(閉じ終わるのを待たない)。pending な
 *   connect は世代を保つ — 復帰時にそのまま採用できる唯一の帰還路だから。
 */

/**
 * What the user should be told about the connection right now. `idle` is the
 * deliberate offline state: this client cut the connection after the idle
 * timeout without user input (see idle.ts) and will reconnect on input.
 */
export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'idle';

/** First retry delay after a failure; doubles per attempt up to the max. */
export const RETRY_INITIAL_MS = 1000;
export const RETRY_MAX_MS = 30_000;

export interface LifecycleState {
  /** Terminal: dispose() ran, nothing may act again. */
  disposed: boolean;
  /** The idle guard holds the connection closed; only `resume` ends this. */
  suspended: boolean;
  /** Some connect succeeded before, so progress reads 'reconnecting'. */
  everConnected: boolean;
  /** A connect() promise is outstanding (attempts are single-flight). */
  attemptInFlight: boolean;
  /** A settled connection is wired as the live session. */
  sessionLive: boolean;
  /**
   * Which connect is current. Socket-close events carry the generation of
   * the attempt that opened the socket; a mismatch means the event is from
   * a superseded session and must not touch the newer one.
   */
  generation: number;
  /** A retry timer is armed (at most one per failure). */
  retryArmed: boolean;
  /** Delay the NEXT armed retry will use (doubles per armed retry). */
  retryDelayMs: number;
  /**
   * Failed connects in a row since the last success; connect() uses it to
   * decide when the stored identity token has become the likely culprit.
   */
  consecutiveFailures: number;
}

export type LifecycleEvent =
  /** startNet's initial kick. */
  | { kind: 'start' }
  /** A connect attempt settled successfully. */
  | { kind: 'connect-ok' }
  /** A connect attempt rejected. */
  | { kind: 'connect-failed' }
  /** The socket of the connect attempt `generation` closed. */
  | { kind: 'socket-closed'; generation: number }
  /** The armed retry timer fired. */
  | { kind: 'retry-due' }
  /** The idle monitor decided to suspend (idle.check → 'suspend'). */
  | { kind: 'idle-timeout' }
  /** User input while suspended (idle.activity → 'resume'). */
  | { kind: 'resume' }
  /** The stack is being torn down. */
  | { kind: 'dispose' };

export type LifecycleEffect =
  /** Start a connect attempt stamped with `generation`. */
  | { kind: 'connect'; generation: number; consecutiveFailures: number }
  /** Adopt the just-settled connection as the live session. */
  | { kind: 'wire-session'; generation: number }
  /** Close the just-settled connection nobody wants (disposed/suspended). */
  | { kind: 'discard-attempt' }
  /** Arm the retry timer to fire `retry-due` after delayMs. */
  | { kind: 'arm-retry'; delayMs: number }
  /** Cancel the armed retry timer. */
  | { kind: 'cancel-retry' }
  /** Tear down the session state (prediction, remote views, conn ref). */
  | { kind: 'drop-session' }
  /** Close the current live connection (a ref captured before drop-session). */
  | { kind: 'disconnect' }
  /** Report the connection status to the UI. */
  | { kind: 'status'; status: ConnectionStatus };

export interface Transition {
  state: LifecycleState;
  effects: LifecycleEffect[];
}

export function initialLifecycle(): LifecycleState {
  return {
    disposed: false,
    suspended: false,
    everConnected: false,
    attemptInFlight: false,
    sessionLive: false,
    generation: 0,
    retryArmed: false,
    retryDelayMs: RETRY_INITIAL_MS,
    consecutiveFailures: 0,
  };
}

/**
 * One transition being built: the handlers below edit the draft state and
 * append effects in the order the shell must perform them.
 */
interface Draft {
  next: LifecycleState;
  effects: LifecycleEffect[];
}

const progressStatus = (d: Draft): ConnectionStatus =>
  d.next.everConnected ? 'reconnecting' : 'connecting';

/** Start a connect unless torn down, one is in flight, or suspended. */
function attempt(d: Draft): void {
  if (d.next.disposed || d.next.attemptInFlight || d.next.suspended) return;
  d.next.attemptInFlight = true;
  d.next.generation += 1;
  d.effects.push({ kind: 'status', status: progressStatus(d) });
  d.effects.push({
    kind: 'connect',
    generation: d.next.generation,
    consecutiveFailures: d.next.consecutiveFailures,
  });
}

/**
 * Arm the next attempt, at most once per failure: a failed connect reports
 * both a rejection and a socket close, so without the armed check the
 * backoff doubled twice per round and the extra timer leaked.
 */
function scheduleRetry(d: Draft): void {
  if (d.next.disposed || d.next.suspended || d.next.retryArmed) return;
  d.effects.push({ kind: 'status', status: progressStatus(d) });
  d.effects.push({ kind: 'arm-retry', delayMs: d.next.retryDelayMs });
  d.next.retryArmed = true;
  d.next.retryDelayMs = Math.min(d.next.retryDelayMs * 2, RETRY_MAX_MS);
}

function onConnectOk(d: Draft): void {
  d.next.attemptInFlight = false;
  // A connect that lands after dispose or while idle-suspended must not
  // open a session nobody asked for. A suspension leaves a pending
  // connect's generation current (see onIdleTimeout), so when the user has
  // already resumed by now, this settle simply becomes the live session.
  if (d.next.disposed || d.next.suspended) {
    d.effects.push({ kind: 'discard-attempt' });
    return;
  }
  d.next.sessionLive = true;
  d.next.everConnected = true;
  d.next.consecutiveFailures = 0;
  d.next.retryDelayMs = RETRY_INITIAL_MS;
  d.effects.push({ kind: 'status', status: 'connected' });
  d.effects.push({ kind: 'wire-session', generation: d.next.generation });
}

function onConnectFailed(d: Draft): void {
  d.next.attemptInFlight = false;
  d.next.consecutiveFailures += 1;
  // While suspended or disposed this is a deliberate no-op; the shell's
  // log must not promise a retry that will not happen.
  scheduleRetry(d);
}

function onSocketClosed(d: Draft, generation: number): void {
  // Closes from a superseded session — an idle suspension bumped the
  // generation when cutting it, or a newer connect took over — are stale
  // and already torn down.
  if (d.next.disposed || generation !== d.next.generation) return;
  d.next.sessionLive = false;
  d.effects.push({ kind: 'drop-session' });
  // A current-generation close while suspended is one we asked for: the
  // discard of a connect that settled after the idle guard cut in
  // mid-attempt. No retry — the next user input reconnects.
  if (d.next.suspended) return;
  scheduleRetry(d);
}

function onRetryDue(d: Draft): void {
  if (d.next.disposed) return;
  d.next.retryArmed = false;
  attempt(d);
}

/** Cancel an armed retry timer; idle suspension and dispose both must. */
function disarmRetry(d: Draft): void {
  if (!d.next.retryArmed) return;
  d.next.retryArmed = false;
  d.effects.push({ kind: 'cancel-retry' });
}

function onIdleTimeout(d: Draft): void {
  if (d.next.disposed || d.next.suspended) return;
  d.next.suspended = true;
  // Suspending also while merely retrying is deliberate — an unattended
  // tab should not keep hammering a host that is down.
  disarmRetry(d);
  d.effects.push({ kind: 'status', status: 'idle' });
  // Invalidate a LIVE session's generation before cutting it: until the
  // socket finishes closing, the old connection can still deliver row and
  // admission callbacks, and without the bump they would pass the stale()
  // check and re-enter the world under an 'idle' status. A merely pending
  // connect keeps its generation, so a resume can adopt it when it settles
  // — attempt() is single-flight, so that pending connect is the resume's
  // only way back in.
  if (d.next.sessionLive) d.next.generation += 1;
  d.next.sessionLive = false;
  // Tear the session down synchronously instead of waiting for the
  // socket's close to report: a resume can start a newer connect before
  // that close lands, and the new session must never find the old one
  // half-alive.
  d.effects.push({ kind: 'drop-session' });
  d.effects.push({ kind: 'disconnect' });
}

function onResume(d: Draft): void {
  if (d.next.disposed || !d.next.suspended) return;
  d.next.suspended = false;
  d.next.retryDelayMs = RETRY_INITIAL_MS;
  // attempt() reports progress itself; the explicit report here covers the
  // one case where it is a no-op — a connect is still pending because we
  // suspended mid-attempt — so the banner does not keep saying "idle" after
  // the user is back (that pending connect is the way back in).
  if (d.next.attemptInFlight) d.effects.push({ kind: 'status', status: progressStatus(d) });
  attempt(d);
}

function onDispose(d: Draft): void {
  if (d.next.disposed) return;
  d.next.disposed = true;
  disarmRetry(d);
  d.next.sessionLive = false;
  d.effects.push({ kind: 'disconnect' });
}

/**
 * One step of the connection state machine. Pure: returns the next state and
 * the side effects the shell must perform, in order. The rules mirror the
 * pre-refactor sync.ts exactly; see the file doc comment for why each guard
 * exists.
 */
export function transition(state: LifecycleState, event: LifecycleEvent): Transition {
  const d: Draft = { next: { ...state }, effects: [] };
  switch (event.kind) {
    case 'start':
      attempt(d);
      break;
    case 'connect-ok':
      onConnectOk(d);
      break;
    case 'connect-failed':
      onConnectFailed(d);
      break;
    case 'socket-closed':
      onSocketClosed(d, event.generation);
      break;
    case 'retry-due':
      onRetryDue(d);
      break;
    case 'idle-timeout':
      onIdleTimeout(d);
      break;
    case 'resume':
      onResume(d);
      break;
    case 'dispose':
      onDispose(d);
      break;
    default:
      // A new event kind must not land here silently (the reducers.ts precedent).
      event satisfies never;
      break;
  }
  return { state: d.next, effects: d.effects };
}
