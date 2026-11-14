import {
  decidePortalCall,
  type E2ENetStats,
  HEARTBEAT_INTERVAL_MS,
  isGroundContactEdge,
  mapFor,
  type PlayerState,
  unpackInput,
} from '@kaede/shared';
import type { DbConnection } from '../module_bindings';
import type { OwnSim } from './playerFeed';

/** What the input sender needs from the net stack that owns it (startNet). */
export interface InputSenderDeps {
  /**
   * The live connection, read at each send — a reconnect swaps it under
   * every send at once (the same getter shape netApi.ts reads through).
   */
  conn(): DbConnection | undefined;
  /** The own simulation's state, held across sessions (see OwnSim in playerFeed.ts). */
  sim: OwnSim;
  /** Counts one send on the dev-only E2E counters (see installNetStats in sync.ts). */
  bumpStat(key: keyof E2ENetStats): void;
}

/**
 * The own simulation's send paths: everything this client pushes to the
 * server while playing — input batches, liveness heartbeats and portal
 * intents — plus the tick and heartbeat checks that drive them.
 */
export interface InputSender {
  /** 生存証明の空バッチを1本送る(定期便と再接続時の生存宣言の共通路)。 */
  sendHeartbeat(c: DbConnection): void;
  /** One input batch: the prediction's send path (see handleOwnRow in playerFeed.ts). */
  sendBatch(startTick: number, packed: Uint8Array): void;
  /**
   * The game loop's local tick: feeds the prediction, flushes on ground
   * contact edges, and fires a portal intent when this tick asks for one.
   */
  handleLocalTick(state: PlayerState, tick: number, packedInput: number): void;
  /** The heartbeat worker's check: sends the empty batch when one is due. */
  heartbeatTick(): void;
}

/**
 * Builds the input sender. It owns the send cadence state — when the last
 * batch went out, the previous tick's input and ground contact — across
 * sessions, like the OwnSim it reads.
 */
export function createInputSender(deps: InputSenderDeps): InputSender {
  const { sim } = deps;

  // いつ最後に submit_inputs を送ったか(バッチ・ハートビートとも)。
  // 送信ゲートが閉じている間はこれが HEARTBEAT_INTERVAL_MS だけ古くなり、
  // ハートビートの送りどきの判定材料になる。
  let lastSendMs = Date.now();

  function sendHeartbeat(c: DbConnection): void {
    lastSendMs = Date.now();
    deps.bumpStat('heartbeatsSent');
    c.reducers.submitInputs({ startTick: 0, inputs: new Uint8Array(0) }).catch(() => {});
  }

  function sendBatch(startTick: number, packed: Uint8Array): void {
    // Batches lost to a dropping connection are expected and already
    // recovered by the resend watchdog, so a per-batch failure is not
    // worth reporting; logging one per flush would bury everything else.
    lastSendMs = Date.now();
    deps.bumpStat('inputBatchesSent');
    deps
      .conn()
      ?.reducers.submitInputs({ startTick, inputs: packed })
      .catch(() => {});
  }

  // The previous tick's packed input, for the portal intent's press edge.
  let prevPackedInput = 0;

  // 前 tick の接地状態(接地エッジ検出用)。undefined = まだ tick がない。
  // prediction の作り直し(再接続・マップ切替)を跨いでも高々1回の余分な
  // フラッシュにしかならないので、prevPackedInput と同じく張り替えない。
  let prevOnGround: boolean | undefined;

  /**
   * Fires enter_portal when this tick's input asks for it (standing in a
   * portal, up pressed this tick, no call already pending —
   * decidePortalCall in @kaede/shared, where the rule is unit-tested).
   * The pending window is flushed FIRST, off the cadence: the WebSocket is
   * ordered, so the server replays every tick the client has simulated
   * before the reducer runs, and its no-slack geometry re-check rules on
   * exactly the state this detection saw. The answer arrives as the own
   * row's mapId flipping (switchMap in playerFeed.ts); failures are silent
   * like submit_inputs — a refusal's only honest consequence is that the
   * map does not change.
   */
  function maybeEnterPortal(state: PlayerState, packedInput: number, prevPacked: number): void {
    const c = deps.conn();
    if (!c || !sim.prediction) return;
    const now = performance.now();
    const portalId = decidePortalCall({
      nowMs: now,
      pendingSinceMs: sim.portalPendingAtMs,
      input: unpackInput(packedInput),
      prevInput: unpackInput(prevPacked),
      state,
      map: mapFor(sim.currentMapId),
    });
    if (portalId === undefined) return;
    sim.prediction.flushNow(now);
    sim.portalPendingAtMs = now;
    c.reducers.enterPortal({ portalId }).catch(() => {});
  }

  function handleLocalTick(state: PlayerState, tick: number, packedInput: number): void {
    const prevPacked = prevPackedInput;
    prevPackedInput = packedInput;
    const wasOnGround = prevOnGround;
    prevOnGround = state.onGround;
    if (!sim.prediction) return;
    sim.prediction.onTick(state, tick, packedInput, performance.now());
    // 踏切・着地の tick は周期を待たず即フラッシュする(理由と費用は
    // isGroundContactEdge のコメントを参照)。ポータルと同じ flushNow なので
    // 周期時計もリセットされ、直後の定期便と二重にはならない。
    if (wasOnGround !== undefined && isGroundContactEdge(wasOnGround, state.onGround)) {
      sim.prediction.flushNow(performance.now());
    }
    maybeEnterPortal(state, packedInput, prevPacked);
  }

  // 静止中の生存証明: 送信ゲート(prediction.ts)が入力送信を止めている間、
  // サーバー行の updatedAt を進めるのはこの空バッチだけになる。これが絶えると
  // OFFLINE_RETENTION_MS 経過で行が掃除され、接続したまま静止している
  // プレイヤーが再join→スポーン地点テレポートしてしまう。Worker 駆動なのは
  // バックグラウンドタブのタイマー間引き対策(heartbeat.ts)。送りどきは
  // 「最後の送信から HEARTBEAT_INTERVAL_MS 以上」— 移動中は入力バッチが
  // lastSendMs を進めるので、ハートビートは自然に黙る。prediction がない間
  // (待合室・入場拒否・行の削除後)は行が無いので送らない。
  function heartbeatTick(): void {
    // dispose 後は heartbeat.dispose() 済みかつ conn も undefined。
    const c = deps.conn();
    if (!c || !sim.prediction) return;
    if (Date.now() - lastSendMs < HEARTBEAT_INTERVAL_MS) return;
    sendHeartbeat(c);
  }

  return { sendHeartbeat, sendBatch, handleLocalTick, heartbeatTick };
}
