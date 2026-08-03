// 同一例外のスロットル(ADR §8.2-B)の純粋な部分。PixiJS の ticker /
// requestAnimationFrame 内で発生するエラーは毎フレーム発火する — 60fps なら
// ユーザー1人・バグ1個で毎分 3,600 件 — ため、フィンガープリント単位の
// レート制限は「見やすさ」ではなく無料枠と課金の生存条件。規則をここに
// 切り出して単体テストし、posthog.ts の before_send は薄い配線に留める。

/** 同一フィンガープリントの例外を送る最短間隔。 */
export const EXCEPTION_THROTTLE_MS = 30_000;

/**
 * ゲートが記憶するフィンガープリント数の上限。メッセージに可変部を含む
 * 例外がキーを無限に増やしても、古い記録から捨てて有界に保つ(上限到達で
 * 送信を止めるのではなく、記憶を失った例外が再び1回通るだけ)。
 */
const EXCEPTION_KEYS_MAX = 200;

/** posthog-js が $exception イベントに載せる例外リストの、指紋に使う部分。 */
interface ExceptionItem {
  type?: unknown;
  value?: unknown;
  stacktrace?: { frames?: unknown };
}

interface ExceptionFrame {
  filename?: unknown;
  function?: unknown;
  lineno?: unknown;
}

const asString = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * $exception イベントのプロパティから同一性のキーを作る。型＋メッセージ＋
 * 先頭フレーム(ファイル・関数・行)で「同じ場所の同じエラー」をまとめる。
 * PostHog サーバー側のグルーピングを置き換えるものではなく、クライアントを
 * 出る前の水門としての近似で十分 — 形が読めなければ固定キーに落ちて、
 * 未知の形の例外も1つの束としてレートに服する(素通りさせない)。
 */
export function exceptionFingerprint(properties: Record<string, unknown> | undefined): string {
  const list = properties?.$exception_list;
  if (!Array.isArray(list) || list.length === 0) return 'unknown';
  const first = (list[0] ?? {}) as ExceptionItem;
  const frames = first.stacktrace?.frames;
  const top = (Array.isArray(frames) ? (frames[0] ?? {}) : {}) as ExceptionFrame;
  const lineno = typeof top.lineno === 'number' ? String(top.lineno) : '';
  return [
    asString(first.type),
    asString(first.value).slice(0, 200),
    asString(top.filename),
    asString(top.function),
    lineno,
  ].join('|');
}

/**
 * キーごとのレートゲート: 前回通過から windowMs 未満の再送を止める。
 * 返り値 true = 送ってよい。記憶は挿入順(= Map の反復順)で捨てるので、
 * サイズは maxKeys に有界。
 */
export function createRateGate(
  windowMs: number = EXCEPTION_THROTTLE_MS,
  maxKeys: number = EXCEPTION_KEYS_MAX,
): (key: string, nowMs: number) => boolean {
  const lastSent = new Map<string, number>();
  return (key, nowMs) => {
    const last = lastSent.get(key);
    if (last !== undefined && nowMs - last < windowMs) return false;
    // 再挿入で「最近使ったキー」を末尾に回す(先頭=最も古い記録)。
    lastSent.delete(key);
    lastSent.set(key, nowMs);
    if (lastSent.size > maxKeys) {
      const oldest = lastSent.keys().next().value;
      if (oldest !== undefined) lastSent.delete(oldest);
    }
    return true;
  };
}
