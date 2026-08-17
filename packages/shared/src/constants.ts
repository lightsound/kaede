/** Simulation tick rate (Hz). Rendering is decoupled from this. */
export const TICK_RATE = 60;
/** Seconds per simulation tick. */
export const DT = 1 / TICK_RATE;

/** Gravity in px/s^2. The y axis points down (screen coordinates). */
export const GRAVITY = 2400;
/** Horizontal move speed in px/s. */
export const MOVE_SPEED = 240;
/** Initial vertical velocity of a jump in px/s (negative = up). */
export const JUMP_VELOCITY = -840;
/** Terminal fall speed in px/s. */
export const MAX_FALL_SPEED = 1200;

/** Player AABB half extents in px. PlayerState (x, y) is the AABB center. */
export const PLAYER_HALF_W = 16;
export const PLAYER_HALF_H = 24;

/** Climbing speed on ropes/ladders in px/s. */
export const CLIMB_SPEED = 140;
/** Max horizontal distance (px) between the player center and a rope to grab it. */
export const ROPE_GRAB_RANGE = 16;
/** Initial vertical velocity when jumping off a rope in px/s (negative = up). */
export const ROPE_JUMP_VELOCITY = -540;
/**
 * Downward nudge (px) applied when dropping through a one-way platform, so the
 * "feet were at the top edge" check no longer holds on the next tick.
 */
export const PLATFORM_DROP_NUDGE = 1;

/**
 * How often a client flushes its pending input batches to the server (ms).
 * 400ms ≒ 移動中 2.5 reducer calls/秒/人 — Phase 2 アイドル抑制の目標
 * 「移動中 2〜3 calls/秒・静止中 0」の中央値(ROADMAP)。ローカル予測は
 * 60fps のまま(1フラッシュに約24 tick を同梱する)ので、延ばして変わるのは
 * ネットワーク送信の頻度とリモートから見た遅延だけ。静止中の 0 は
 * evaluateSendWindow(sendGate.ts)が担う。踏切・着地の tick だけは周期を
 * 待たず即フラッシュされる(isGroundContactEdge — 床接触がサンプルに
 * 写らないと連打ジャンプが2段ジャンプに見えるため)。
 */
export const INPUT_FLUSH_INTERVAL_MS = 400;
/**
 * Remote players are rendered this far in the past (ms) so that there are
 * always two snapshots to interpolate between: one full input-flush window
 * (INPUT_FLUSH_INTERVAL_MS) plus headroom for delivery jitter. Raising the
 * flush interval raises this floor with it.
 */
export const INTERP_DELAY_MS = 550;

/**
 * Max ticks accepted per submit_inputs call; clients chunk bigger backlogs.
 * One nominal flush window is TICK_RATE * INPUT_FLUSH_INTERVAL_MS/1000
 * (= 24) ticks; 60 keeps even a jittery or briefly throttled window in a
 * single call, so the moving-rate target is met without extra calls.
 */
export const INPUT_BATCH_MAX_TICKS = 60;
/**
 * Server-side speed-hack guard (token bucket): how many ticks a player may run
 * ahead of the server wall clock before batches are refused. Absorbs the flush
 * cadence and clock jitter of honest clients.
 */
export const TICK_ALLOWANCE_SLACK = 30;
/**
 * Token-bucket cap: at most this many unspent ticks accrue while a player is
 * idle or lagging (~1s), bounding the movement burst a client can replay after
 * falling behind. Without a cap, time spent throttled in a background tab
 * would bank an unlimited fast-forward allowance.
 */
export const MAX_TICK_BANK = 60;
/**
 * How long a player row may sit unwritten (ms) before the join-time sweep
 * reclaims it: a reload or network blip within the window resumes the same
 * character, and rows stranded by a host that died without
 * client_disconnected eventually leave the world. While connected, liveness
 * is proven by input batches when moving and by heartbeats when the send
 * gate is closed (HEARTBEAT_INTERVAL_MS) — the window tolerates two missed
 * heartbeats before a live player is swept.
 */
export const OFFLINE_RETENTION_MS = 10 * 60_000;
/**
 * 静止中(送信ゲートが閉じている間)にクライアントが生存証明として送る
 * 空の submit_inputs の間隔 (ms)。サーバーはこれで player.updatedAt を進め、
 * オフライン掃除(isExpiredRow)から接続中の静止プレイヤーを守る。
 * 実効の最悪送信間隔は判定粒度を足した HEARTBEAT_INTERVAL_MS +
 * HEARTBEAT_CHECK_INTERVAL_MS = 180s。その3倍(=2回連続で落としても3本目が
 * 届く時刻)が OFFLINE_RETENTION_MS(600s)より 60s 手前に来るので、配送
 * 遅延や判定コールバックのジッタが乗っても、生きている静止プレイヤーが
 * 掃除されることはない。この不変条件は guard.test.ts が固定する。
 * スケジューリングはメインスレッドのタイマーではなく Web Worker で行う
 * (heartbeat.ts): バックグラウンドタブのタイマー間引き(Chrome の intensive
 * throttling は約1回/時)がメインスレッド側の予定を丸ごと止めるため。
 */
export const HEARTBEAT_INTERVAL_MS = 120_000;
/**
 * ハートビートの送りどきを見る判定周期 (ms)。Worker がこの間隔で刻み、
 * メインスレッドが「最後の送信から HEARTBEAT_INTERVAL_MS 以上か」を判定する
 * (heartbeat.ts / sync.ts)。粒度が粗いほど実効間隔が延びるため、上の
 * 掃除余裕の式に含める。
 */
export const HEARTBEAT_CHECK_INTERVAL_MS = 60_000;
/**
 * サーバーがハートビートによる行の書き換え(updatedAt 更新)を受け入れる
 * 最短の行齢 (ms)。行更新は全購読者への egress を伴うため、空バッチを
 * 乱打するクライアントがいても書き込みは最大 1回/分/人 に抑えられる。
 */
export const HEARTBEAT_MIN_AGE_MS = 60_000;
/**
 * Client resend watchdog: re-send un-acked inputs after this long (ms).
 * The watchdog only runs at flush time, so the timeout is 3x the flush
 * interval: one in-flight window plus round-trip headroom, without
 * re-sending on every ordinarily-timed ack.
 */
export const RESEND_TIMEOUT_MS = 1200;
/** Client keeps at most this many ticks of prediction history (~10s). */
export const PREDICTION_HISTORY_MAX_TICKS = 600;
