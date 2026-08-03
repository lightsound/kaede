/**
 * 送信ゲート: 静止中のクライアントが入力送信を完全に止めてよいかの判定
 * (ROADMAP Phase 2 アイドル抑制)。prediction.ts がフラッシュのたびに呼ぶ。
 *
 * 「入力なし」だけでは止められない: キーを離してもジャンプ後の落下や着地は
 * 続き、サーバーは受信した入力ぶんしか tick を進めないので、送信を止めた
 * 瞬間にサーバーの世界だけ空中で凍る。判定は3条件の AND:
 *
 * 1. 保留中の全 tick が空入力(送る意図がない)
 * 2. ウィンドウ先頭の状態 — サーバーが次のバッチをリプレイする起点 — が
 *    静止(isQuiescent)。静止状態は空入力の不動点なので、このとき保留中の
 *    全 tick は no-op だと保証できる。「今の状態が静止」では不十分な点に
 *    注意: 落下中に送信を止め、着地した tick だけ見て静止と判定すると、
 *    着地がサーバーに届かない
 * 3. 送信済みがすべて ack 済み。未 ack のバッチが残ったまま黙ると、それが
 *    落ちていた場合に再送ウォッチドッグごと止まり、サーバーと永久に食い
 *    違う(サーバー側のギャップ受理も「ギャップ中に実入力はなかった」前提を
 *    崩される)
 *
 * skip のとき、クライアントはウィンドウを送らずに送信済み/ack 済み位置を
 * 仮想的に進める。次に本当に送るバッチの startTick はサーバーの行 tick より
 * 先になるが、サーバーは行が静止していればギャップを空入力として受理する
 * (guard.ts の evaluateInputBatch)。
 */
import { isQuiescent } from './player';
import type { PlayerState } from './types';

export type SendWindowVerdict = 'send' | 'skip';

export function evaluateSendWindow(window: {
  /** 保留ウィンドウ ((lastSentTick, currentTick]) に空でない入力があるか。 */
  anyInput: boolean;
  /** ウィンドウ先頭の状態 = サーバーが確認済みの状態(lastSentTick 時点)。 */
  windowStartState: PlayerState;
  /** 送信済みの全 tick が ack 済みか (lastSentTick === ackedTick)。 */
  fullyAcked: boolean;
}): SendWindowVerdict {
  const { anyInput, windowStartState, fullyAcked } = window;
  if (anyInput || !fullyAcked) return 'send';
  return isQuiescent(windowStartState) ? 'skip' : 'send';
}
