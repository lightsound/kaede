# ADR: ブラウザエラー監視に Sentry ではなく PostHog を採用する

- **ステータス**: **採用（2026-08-03 確定）** — 独立レビュー（→ 追補）を経てオーナーが承認。
  Stripe Projects で posthog/free ＋ posthog/analytics（US リージョン）をプロビジョニング済み。
  sentry-project・sentry-plan は削除済み
- **対象**: kaede
- **最終更新**: 2026-08-03

---

## 1. 決定

**ブラウザ側の観測ツールとして PostHog を採用する。Sentry は採用しない。**

外部ベンダーはこの 1 つに限定し、サーバー側は Cloudflare 純正機能と SpacetimeDB のダッシュボードで賄う。

---

## 2. この判断が依存している前提

以下 4 つが崩れた場合、判断は変わりうる（→ §7）。

| # | 前提 | 出所 |
|---|---|---|
| P1 | Cloudflare の機能で済むものは Cloudflare に任せる | 方針 |
| P2 | ソロ開発（ダッシュボードを見るのは 1 人） | 体制 |
| P3 | サーバーロジックの本体は SpacetimeDB のリデューサー。Workers は薄いグルー（トークン発行・Webhook・R2）に限定 | アーキテクチャ |
| P4 | クライアントは PixiJS v8 のキャンバス描画が主体 | アーキテクチャ |

---

## 3. 観測レイヤーの分担

| 層 | 実体 | 担当 |
|---|---|---|
| ブラウザ | React 19 + PixiJS v8 | **PostHog** |
| Cloudflare Workers | トークン発行・Webhook・R2 | Workers Logs / Traces / Analytics Engine |
| **SpacetimeDB** | **リデューサー = サーバー本体** | **Maincloud ダッシュボード + `spacetime logs`（別窓）** |
| 経路全体の生存確認 | ログイン〜WS 接続〜テーブル同期 | Cron Worker + `@cloudflare/playwright` |
| 通話・録画 | RealtimeKit | Cloudflare 側 |
| Web パフォーマンス | Core Web Vitals | Cloudflare Web Analytics |

### 3.1 SpacetimeDB は原理的に外部ツールを入れられない

リデューサーはトランザクション内で動き、**外部と一切やりとりできない**。決定的であることが要求され、ファイルシステム・ネットワーク・タイマー・乱数はすべて禁止されている。

> **したがって Sentry・PostHog いずれの SDK も、リデューサー内には設置不可能。**
> これは好みではなくアーキテクチャ上の制約である。

観測手段は以下に限られる。

- `console.log` / `warn` / `error` が内部ロギングに routing され、`spacetime logs --level error` で参照
- プログラマエラー（バグ由来の想定外エラー）は Maincloud のダッシュボードに表示
- Maincloud は DB ごとにリアルタイムダッシュボードをホスト（性能計測 + リデューサー直接実行の管理パネル）

**抜け道**: Procedures は DB 外の操作が可能で、外部サービスへの HTTP リクエストを送れる。HTTP ハンドラ / Webhook も存在するが unstable フラグの後ろ。
→ Phase 2 でこの配管を自作する価値はないと判断。**別窓として受け入れる。**

### 3.2 Cloudflare が埋められない唯一の穴

Cloudflare Web Analytics / RUM は **性能計測（Core Web Vitals・ページロード）専用で、JS 例外は扱わない**。加えて最初のクライアントリクエストのみが対象で、Worker サブリクエストからは収集不可。

> **ブラウザの未捕捉例外のスタックトレースだけが、他のどの層からも観測できない。**
> 外部ツールを入れる理由はこの 1 点に集約される。

---

## 4. PostHog を選ぶ理由

### 4.1 無料枠の差が実用上の分岐になる

| | Sentry Developer | PostHog Free |
|---|---|---|
| エラー / 例外 | 5,000 | **100,000** |
| セッションリプレイ | **50** | **5,000** |
| イベント | — | 1,000,000 |
| フィーチャーフラグ | なし | 1,000,000 リクエスト |
| ユーザー | 1 | 無制限 |

**リプレイ 50 件/月が決定的。** PixiJS のキャンバスゲームで「何が起きたか」を知る主力手段はリプレイであり、ドッグフーディング 1 週間で枯渇する。

なお超過単価は帯によっては大差ない（PostHog 10〜32.5 万で $0.000370、Sentry Team 5〜10 万で $0.0003625）。**差は無料枠の広さであって、単価ではない。**

### 4.2 フィーチャーフラグが「監視より上流の対策」になる

ソロで本番に実メンバーを投入する以上、段階公開と即時 kill switch は「壊れたことに気づく」より効く。PostHog は無料枠に含む。Sentry は持たない。

### 4.3 生涯ツール数が 1 つ少ない

| 経路 | 系統数 |
|---|---|
| Cloudflare + Sentry（今）→ + PostHog（SaaS 期） | **3** |
| Cloudflare + PostHog（今〜SaaS 期） | **2** |

ソロで最も希少なのは時間と注意力。ツールが 1 つ増えるたびに、ダッシュボード・通知チャンネル・SDK 更新・請求メーターが 1 つずつ増える。

### 4.4 想定される障害モードと相性が良い

心配している「放置タブ・スリープ復帰・再接続失敗」は**例外として投げられないサイレントな劣化**である。

- 捕捉手段は「`reconnect_failed` イベントの発生率が跳ねた」というトレンド検知
- これは分析ツールの土俵であり、Issue 中心の Sentry のモデルとは噛み合わない
- PostHog はイベントのトリガー・フィルタ・トレンドに基づくリアルタイムアラートを持ち、Slack / Discord / Teams / Webhook に送出できる

### 4.5 ソースマップ運用は Sentry とほぼ同等（当初評価を訂正）

Vite は Rollup ベースのため `@posthog/rollup-plugin` をそのまま使用可能。

- `personalApiKey` と `projectId` を渡すだけで生成・アップロードが自動化
- `deleteAfterUpload` がデフォルト `true` → 公開されない
- 本番 JS に `//# chunkId=...` を注入して突き合わせる方式
  → **Sentry の Debug ID と同じ設計**。URL マッチング依存の旧世代方式より堅く、CDN パスやファイル名ハッシュの変化で壊れない
- `posthog-cli sourcemap inject` / `upload` が分離。継続的デプロイならリリース名のみ指定し、バージョンは git commit hash を自動検出させるのが推奨
- アップロード結果は symbol sets 画面で検証可能

> 検討初期に「ソースマップ運用は Sentry が明確に上」と評価したが、これは誤り。**減点材料から除外する。**

---

## 5. Sentry の優位点と、それでも採らなかった理由

公平のため記録する。

### 5.1 今も Sentry が優れている点

**エラーのグルーピング精度。** PostHog は公式ドキュメントで「グルーピングアルゴリズムの改善に取り組んでいます」「自動グルーピングの品質は利用できるデータによって変動しうる」と明記している。ベンダーとしては率直だが、**まだ到達していないという自己申告**でもある。

**Seer Agent。** エラー・スパン・ログ・トレース・コードコンテキストを横断した自然言語調査と、Cursor / Claude Code への引き渡し。

**アカウントが既に存在する。** Stripe Projects でプロビジョニング済みのため、着手コストはほぼゼロ。

### 5.2 採らなかった理由

Sentry を推す最大の根拠だった以下は、**P1 と P3 によって前提ごと消滅した**。

| 当初の根拠 | 失効理由 |
|---|---|
| ブラウザ⇄Worker の分散トレース接続 | Worker 側を Cloudflare 純正に任せるため不要（P1） |
| `@sentry/cloudflare` の D1 / Durable Objects / Workflows 計装 | **観測対象が存在しない**（P3） |
| PostHog のトレースが alpha という減点 | PostHog にトレースをやらせないため無効（P1・P3） |
| プロファイリング・cron 監視 | サーバー側の機能でありブラウザ限定では対象外 |

グルーピング精度の差については、**kaede ではどのみち手動制御が必要**（→ §8.2）。差の影響は限定的と判断した。

---

## 6. 検討して外した選択肢

| 候補 | 外した理由 |
|---|---|
| **Better Stack** | 最大の武器（オンコール・エスカレーション・電話通知無制限）がソロでは無効化される。ステータスページのみのために採用する価値は薄い |
| **Honeybadger** | 唯一の対抗馬。ブートストラップ企業で安定、Insights の Cloudflare R2 レプリケーション対応、uptime + status page + cron 監視が同梱。**ただしセッションリプレイが無い** ためキャンバスゲームでは不利 |
| **Rollbar** | 無料枠にリプレイ 1,000 件を含む点は良い。ただし最大の強み（全有料プランでユーザー無制限）がソロでは無意味。レビューで重複エラーの多さが指摘されている |
| **Bugsnag / SmartBear Insight Hub** | モバイルクラッシュが主戦場。2026 年半ば時点で価格が非公開（見積もり依頼モデル）。G2 の Product Direction スコアが 7.4（Sentry 9.3） |
| **GlitchTip** | Sentry SDK 互換で思想は良いが Django ベースで **Cloudflare に載らない**。VPS が別途必要となり P1・P2 と真っ向から衝突。リプレイ無し |
| **HyperDX** | 唯一の直接競合だったが、ClickHouse 社の姿勢を理由に候補から除外 |
| **Statsig** | 2025-09 に OpenAI が $1.1B で買収 → 2026-05-05 に Amplitude がブランドと顧客を引き継ぎ、チームは OpenAI に残留。**所有権が不安定で長期依存に適さない** |
| **自作（`error-stack-parser-es` 等）** | パースは問題の最も簡単な部分。**ソースマップ解決・グルーピング・レート制限**が丸ごと残る。特に PixiJS のゲームループでは 60fps × 同一エラーで自分の Worker を DoS するリスク（→ §8.2） |
| **Axiom / Grafana Loki / Tinybird / OTLP** | レイヤーが異なる。OTLP は規格であり製品ではない。Tinybird の役割（ユーザー向け統計）は当面 Analytics Engine で代替可能 |

---

## 7. 判断が覆る条件（見直しトリガー）

以下のいずれかが真になったら、この ADR を再評価する。

1. **リプレイが不要と結論が出た** → 最大の減点が消え、Sentry または Honeybadger が優位になる
2. **フィーチャーフラグを別系統で持つことにした** → §4.2 が失効
3. **SaaS 期の分析を PostHog 以外で行うと決めた** → §4.3 の「生涯 2 系統」が崩れる
4. **エラーの原因究明に時間を取られて開発が停滞した** → グルーピング精度の差が実測で効いている証拠
5. **Workers に実質的なロジックが移った**（P3 の変化）→ Sentry の Cloudflare 統合が再び意味を持つ
6. **チームが 2 人以上になった**（P2 の変化）→ オンコール・アサインの価値が発生し Better Stack が復活しうる

**移行コストの前提**: PostHog は独自 SDK のため、Sentry / Better Stack / GlitchTip へ移る場合は再計装が必要。逆に Cloudflare 側は OTel なので宛先の差し替えのみで済む。
→ **外部依存を PostHog 1 点に絞る代わりに、そこは再計装リスクを引き受ける**という構図。

---

## 8. 実装メモ

### 8.1 導入順序（安い順）

1. **SpacetimeDB SDK を先に上げる**
   TypeScript SDK が `visibilitychange` / `focus` / `online` / `pageshow` を購読し、タブ復帰やネットワーク復旧時に停止した再接続バックオフをリセット、死んだソケットを破棄・再構築する挙動が入っているか確認する。
   → **入っていれば Phase 2 の懸念の一部は監視ではなく SDK 更新で消える。観測可能にするより起きなくする方が安い。**

2. **接続イベントをサーバー側で記録**
   `client_connected` / `client_disconnected` をイベントテーブルに書き、SQL で再接続失敗率を追う。**ネットワークが死んでいる時はブラウザ側のビーコンも送れない**ため、この一次情報源はサーバー側に置く必要がある。

3. **`posthog-js` を最小構成で導入**（リプレイなし）

4. **リプレイは必要になってから追加**

### 8.2 必須の実装（省略不可）

**A. WebSocket は自動計装されない**

Sentry のデフォルト breadcrumb 対象は `console` / `dom` / `fetch` / `history` / `xhr` のみで WebSocket を含まない（要望 Issue は 2023 年から未クローズ）。PostHog も同様。

SpacetimeDB の接続ライフサイクルは自前でイベント化する。

```ts
conn.onDisconnect(() => {
  posthog.capture('spacetimedb_disconnected', { readyState, reconnectAttempt })
})
```

再接続の N 回連続失敗は例外として投げられないため、**明示的に送出しないと何も記録されない**。

**B. ゲームループのレート制限**

PixiJS の ticker / `requestAnimationFrame` 内でエラーが発生すると毎フレーム発火する。60fps ならユーザー 1 人・バグ 1 個で毎分 3,600 件。

`before_send` でフィンガープリントとスロットルを最初から入れる。

```ts
posthog.init(KEY, {
  before_send: (event) => {
    if (event.event === '$exception') {
      // 同一フィンガープリントは N 秒に 1 回まで
    }
    return event
  }
})
```

> **グルーピングは「見やすさ」の機能ではなく、ゲームでは生存に必要な機能。**

**C. 課金上限をプロダクトごとに設定**

PostHog は横断の合計上限を持たず、プロダクト単位の上限のみ。導入初日に全メーターへ設定する。

**D. identified events は anonymous の最大 4 倍単価**

匿名のうちは `identify()` を呼ばない設計にする。`distinct_id` は Clerk の user ID に揃える。

### 8.3 キャンバス録画の注意点

- PostHog は 2D / WebGL の両方に対応。デフォルト 4fps、`canvasFps` と `canvasQuality` で調整可能
- **キャンバスに PII マスキングは効かない**（PostHog / Sentry 共通）。オフィス内のチャットや氏名を描画する場合は要検討
- キャンバスを画像としてキャプチャするため、サイトによっては性能影響あり
- 60fps でフレーム予算と戦っている最中に無条件で有効化しない。**まず例外のみを拾い、「スタックトレースだけでは分からない」実例が出てから追加する**

### 8.4 ソースマップ

```ts
// vite.config.ts
import posthog from '@posthog/rollup-plugin'

export default defineConfig({
  plugins: [
    posthog({
      personalApiKey: process.env.POSTHOG_API_KEY,
      projectId: process.env.POSTHOG_PROJECT_ID,
      sourcemaps: { deleteAfterUpload: true },
    }),
  ],
})
```

`build.sourcemap: 'hidden'` と併用し、公開せずアップロードのみ行う。

### 8.5 外形監視（外部ベンダー追加なし）

Cron Trigger の Worker から `@cloudflare/playwright` で最小シナリオ（Clerk ログイン → WS 接続 → テーブル同期確認）を実行し、失敗時に PostHog / Discord へ送出。

- `nodejs_compat` + compatibility_date 2025-09-15 以降が必要
- Playwright の storage state を Workers KV に永続化して Clerk セッションを再利用
- `@cloudflare/playwright` は上流とバージョンがずれるフォークのため、`e2e` パッケージのスクリプトをそのまま流用せず監視用の最小版を別に書く
- Browser Rendering のセッション上限と課金を事前確認

### 8.6 その他

- **Alchemy v2 は Cloudflare 限定**のため PostHog の設定は IaC 外に出る。ダッシュボード設定を最小化し、可能な限り `posthog.init` のコードに寄せる
- **fallow 全ルール error** のため、SDK 初期化コードがデッドコード検出にどう見えるかを導入直後に確認する

---

## 9. 未解決事項

| # | 項目 | 対応 |
|---|---|---|
| 1 | グルーピング精度が実運用で許容範囲か | Phase 2 の最初の 2 週間、issue リストを意識して観察。同一バグの分裂／無関係な統合が頻発するなら再評価 |
| 2 | SpacetimeDB 2.7 に SDK の再接続自動回復が含まれるか | 着手前に確認（§8.1-1） |
| 3 | キャンバス録画の性能影響 | 有効化時に fps / quality を絞って実測 |
| 4 | Sentry との並走比較を行うか | アカウントは既にある。両方の無料枠で 1〜2 週間並走させる案は費用対効果が高い |
| 5 | Browser Rendering のセッション上限・課金 | 外形監視の実装前に確認 |

---

## 付録: 検討の経緯（推奨が変わった記録）

将来の自分のために、判断が変わった経緯を残す。

| 段階 | 推奨 | 変化の要因 |
|---|---|---|
| 初期 | **Sentry** | ブラウザ⇄Worker のトレース接続と Cloudflare プリミティブ計装を重視 |
| 「Cloudflare で済ませたい」判明後 | **PostHog** | Worker 側を純正に任せるため、Sentry の最大の根拠が前提ごと消失 |
| 「ソロ開発」判明後 | PostHog（確度上昇） | ツール数最小化がコストの本体に。1 ユーザー制限を問題視した当初評価は誤りと判明（実メンバーはゲームのユーザーであってダッシュボード閲覧者ではない）— 撤回済み |
| スタック詳細判明後 | PostHog（維持） | SpacetimeDB がサーバー本体であり、そもそも Sentry の Cloudflare 統合は「効かない」のではなく**対象が存在しない**ことが判明 |
| ソースマップ調査後 | PostHog（減点解消） | `@posthog/rollup-plugin` + chunkId 方式が Sentry と同等水準と判明。当初の「Sentry が明確に上」評価を訂正 |

**残る唯一の実質的な差はグルーピング精度のみ。** これも kaede では手動制御が前提となる領域であり、影響は限定的と結論した。

---

## 追補（2026-08-03 採用時レビュー）

採用確定前に本文の主要な事実主張を独立に再検証した。結論は不変だが、以下を訂正・補足する。

### 検証で確認できたこと

- 無料枠の数字（§4.1）はすべて 2026-08 時点の公式情報と一致
- Sentry も `replayCanvasIntegration` で WebGL 録画に対応しており（`preserveDrawingBuffer` の
  性能注意・手動スナップショット回避・PII マスキング不可まで PostHog と同条件）、
  リプレイの差は機能ではなく純粋に枠（50 vs 5,000）である — §4.1 の論旨を補強
- `@posthog/rollup-plugin` は実在し Vite 公式ドキュメントあり（§4.5 のとおり）。
  ただし hidden sourcemap 不具合の修正が 2026-01 に入ったばかりで、**設計は Sentry 同等・
  実績は浅い**。導入時に symbol sets 画面での検証を必ず行う

### 本文への訂正

1. **§4.4 の「リアルタイムアラート」は実態より強い表現**。正確には:
   issue 作成/再オープン通知（即時）、スパイク検知（5 分バケット×1 時間ローリング
   ベースライン）、トレンドアラート（スケジュール実行・最短 hourly で**リアルタイムではない**）、
   完全リアルタイムが必要なら Data Pipelines の `$exception` destination（スロットル可）を自作。
   「`reconnect_failed` の発生率が跳ねた」の検知は最速でも数分〜1 時間遅れる。
   ソロ・非オンコール運用では許容と判断
2. **§5.1 の Seer は有料サブスクリプション**で、無料 Developer プランでは使えない。
   Sentry の優位点としては過大評価だった
3. **§4.1 の表に漏れ**: Sentry 無料枠には uptime モニター 1 本・cron モニター 1 本が含まれる。
   §8.5 の外形監視の比較対象になり得たが、シナリオ監視（ログイン→WS→同期）は
   どのみち自作が必要なため判断は不変

### 補足（本文に未記載の追い風）

4. **Stripe Projects カタログに posthog/analytics（Free）が存在**し、kaede の
   プロビジョニング・請求レイヤーにそのまま乗る。§5.1 の「Sentry はアカウントが既にある」
   という優位は実質無効化された
5. **PostHog は公式ホスト型 MCP サーバー**（`mcp.posthog.com` — エラー調査・フラグ操作・
   リプレイ検索・SQL など 50+ ツール）を持ち、「管理操作もエージェント主体」方針と整合。
   VISION が Sentry MCP を根拠にしていた箇所は書き換え済み

### 運用上の注意（追加）

6. **PostHog Free は 1 プロジェクト・リプレイ保持 1 ヶ月**（イベントは 1 年）。
   環境分離は「開発環境では `posthog.init()` しない」設計で対応する
7. §9-4 の Sentry 並走比較は、Sentry リソース削除に伴い**実施しないことに決定**。
   グルーピング精度に問題が出た場合（§7-4）は Stripe Projects から無料で
   再プロビジョニングして比較すればよい
8. 見直しトリガー（§7）に追加: **アラート遅延が実運用で問題になった場合**（上記訂正 1 参照）
