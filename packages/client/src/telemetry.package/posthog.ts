// fallow-ignore-file coverage-gaps -- posthog-js ブラウザ SDK の薄いグルー。判断できる規則(スロットル)は throttle.ts に切り出して単体テスト済み
//
// エラー監視(PostHog)の初期化と送出口(ADR §8.2 の必須実装)。設定は
// ダッシュボードではなく可能な限りこの init に寄せる(ADR §8.6)。
// リプレイは意図的に含めない(§8.3 — 必要になってから)。
import posthog from 'posthog-js';
import { createRateGate, exceptionFingerprint } from './throttle';

// ビルド時定数(vite.config.ts の define)。本番ビルドだけ実キーが入り、
// dev ビルドは常に空文字 — ローカル .env に実キーが存在するため「キーの
// 有無」では dev を止められず、ビルドモードでゲートする(Free 枠は
// 1 プロジェクトで、dev のノイズが本番プロジェクトを直接汚染するため)。
// typeof ガードは vitest(client の vite.config を通らない)で定数が
// 存在しないケースのため。
const KEY = typeof __KAEDE_POSTHOG_KEY__ === 'string' ? __KAEDE_POSTHOG_KEY__ : '';
const HOST = typeof __KAEDE_POSTHOG_HOST__ === 'string' ? __KAEDE_POSTHOG_HOST__ : '';

/** init が実行されたか。false の間、送出口はすべて no-op。 */
let active = false;

/** identify() 済みか。reset() を「識別していたときだけ」に絞るための記憶。 */
let identified = false;

/**
 * PostHog を最小構成で初期化する(main.tsx から1回)。キーのないビルド
 * (dev、CI の PR ビルド)では何もしない。
 * - 例外の自動捕捉(未捕捉例外・unhandled rejection)だけを有効にし、
 *   ページビュー・DOM オートキャプチャ・性能計測・リプレイは切る:
 *   キャンバス描画の SPA では DOM イベントに意味がなく、性能計測は
 *   Cloudflare Web Analytics の担当(ADR §3)。
 * - before_send のスロットルは省略不可(§8.2-B): ゲームループ内の
 *   エラーは毎フレーム発火する。
 * - person_profiles は identified_only(§8.2-D): 匿名イベントに人物
 *   プロファイルを作らない(identified events は匿名の最大4倍単価)。
 */
export function initTelemetry(): void {
  if (!KEY) return;
  const gate = createRateGate();
  posthog.init(KEY, {
    api_host: HOST,
    person_profiles: 'identified_only',
    capture_pageview: false,
    autocapture: false,
    capture_performance: false,
    disable_session_recording: true,
    capture_exceptions: true,
    before_send: (event) => {
      if (!event || event.event !== '$exception') return event;
      return gate(exceptionFingerprint(event.properties), Date.now()) ? event : null;
    },
  });
  active = true;
}

/**
 * 明示イベントの送出口(§8.2-A)。WebSocket は自動計装されないため、
 * SpacetimeDB の接続ライフサイクル(切断・再接続の連続失敗・ゾンビ検出)は
 * net.package がここへ明示的に送る — 送らなければ何も記録されない。
 */
export function captureEvent(name: string, properties?: Record<string, unknown>): void {
  if (active) posthog.capture(name, properties);
}

/**
 * メンバーの distinct_id を Clerk user ID に揃える(§8.2-D)。匿名
 * (ゲスト・サインアウト中)では決して呼ばない — 呼び出し側の規約では
 * なく、サインイン済みツリーだけがこれを呼ぶ配線(ClerkGate)で担保する。
 */
export function identifyMember(clerkUserId: string): void {
  if (!active) return;
  posthog.identify(clerkUserId);
  identified = true;
}

/**
 * サインアウト時に匿名へ戻す。identify() していないときは no-op —
 * 無条件の reset() はゲストの匿名 distinct_id をマウントのたびに
 * 回転させ、同一ブラウザの継続性を意味なく壊すため。
 */
export function resetIdentity(): void {
  if (!active || !identified) return;
  posthog.reset();
  identified = false;
}
