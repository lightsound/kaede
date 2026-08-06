# kaede

> **プロジェクトの方向性について**: 本プロジェクトは、ゲーム（MMORPG）ではなく
> **メイプルストーリー風 2D 横スクロールのワークコラボレーションツール「kaede」**
> （oVice / Gather のようなバーチャルオフィス）を目指す方針にピボットしました。
> ビジョンと決定事項は [docs/VISION.md](./docs/VISION.md)、フェーズ計画は
> [docs/ROADMAP.md](./docs/ROADMAP.md) を参照してください。
> 以下は現時点の実装（ロードマップの Phase 0: ネットコード基盤）の説明です。

メイプルストーリー風2D横スクロール世界の最小プロトタイプ（MVP）です。
複数のブラウザウィンドウから同じワールドに接続し、互いのキャラクターがリアルタイムに同期して動く様子を確認できます。

## 技術スタック

- **TypeScript 7** — 全パッケージ共通の言語（ネイティブ実装の `tsc`）
- **PixiJS v8** — 2Dレンダリング
- **Vite + React** — クライアントのビルド／開発サーバー（Reactの役割はキャンバスのマウントのみ）
- **SpacetimeDB 2.x** — リアルタイム同期バックエンド（DB兼サーバーロジック）
- **pnpm workspaces** — モノレポ管理
- **Vitest** — ユニットテスト（リポジトリ全体を1回のrunで実行し、カバレッジも1本にまとめる）
- **Biome** — lint とフォーマット
- **fallow** — デッドコード・重複・複雑度・アーキテクチャ境界の静的解析

### 静的解析の方針

`.fallowrc.jsonc` は fallow が持つ**全53ルールを例外なく `error`** に上げています。既定で `warn` の
クリーンアップ系・スタイル系ルールも、既定で `off` のオプトインルール（`private-type-leaks`、
`prop-drilling`、`thin-wrapper`、`duplicate-prop-shape`、`coverage-gaps`、`security-*`、
`require-suppression-reason`、`feature-flags`）も含みます。あわせて次を有効化しています。

- **`typeAware`（`require: "complete"`）** — TypeScript のセマンティック解析。判定が部分的な
  ままなら通しません。バックエンドは fallow が同梱する TypeScript です（`fallow-type-aware`
  が `typescript@7.0.2` を自前に固定しており、各パッケージの TypeScript とは独立です）。
  `pnpm exec fallow --format json` の `_meta.check.type_aware` で確認できます。
- **`boundaries`** — README が説明するアーキテクチャそのものの強制。`shared` は葉であり何も
  import せず、`client` と `server` は `shared` だけを見ます（互いは不可視）。`requireAllFiles`
  によりどのゾーンにも属さないファイルも検出され、例外は `vitest.config.ts` の1件だけを
  名指しで許可しています。
- **`duplicates.mode: "semantic"`** — 変数名を変えただけの複製（Type-2 クローン）も検出します。
- **`includeEntryExports`** — エントリポイントの export も未使用検査の対象にします。
- **`health.coverage`** — 実カバレッジを読ませ、CRAP スコアを推定ではなく実測にします。
- **`sealed`** — 設定が外部の `extends` を引き込めないようにします。

`infra/`（Alchemy の IaC）は typecheck と Biome の対象ですが、ユニットテスト（カバレッジ）と
ImportLint の対象外です（`alchemy.run.ts` は alchemy CLI が実行する宣言的な単一エントリポイントで、
アプリのモジュールグラフに参加しないため。fallow は infra も走査し、エントリポイント判定の
偽陽性1件のみ理由付きコメントで抑制しています）。

グローバルに無効化しているルールはありません。例外は個別の抑制コメント
（`// fallow-ignore-file <rule> -- <理由>` またはその行だけに効く `// fallow-ignore-next-line ...`）
でのみ表明し、`require-suppression-reason` により理由のない抑制は許されません
（`pnpm exec fallow suppressions` で全件を一覧できます）。
なお `feature-flags` だけは `error` にしても実際には終了コードを変えない報告専用ルールです
（インベントリは `fallow flags` で確認できます）。

## パッケージ構成

| パッケージ | 説明 |
| --- | --- |
| `packages/shared` | 物理シミュレーション・マップ・定数など、クライアントとサーバーで共有するロジック |
| `packages/client` | PixiJS + React のクライアント（ローカル操作の描画とネットワーク同期） |
| `packages/server` | SpacetimeDB モジュール（`player`・`player_name`・`player_guard`・`account`・`space_member`・`space_setting` テーブルと `join`・`submit_inputs`・管理系リデューサー。サーバー権威で物理・入場制御を実施。高頻度更新の `player` 行から低頻度の表示名（`player_name`、公開）とガード内部値（`player_guard`、非公開）を分離し、行更新1回あたりの egress を抑える） |
| `packages/e2e` | Playwright の E2E スモークテスト（ゲスト2ブラウザの「入場→移動同期」をフルスタックで検証） |
| `packages/worker` | 通話 API の Cloudflare Worker（`kaede-call`）。RealtimeKit のミーティング作成・参加トークン発行という「シークレットを要する外部 API 呼び出し」だけを行う薄いステートレスなグルー（VISION のバックエンド原則）。状態は持たない — どのグループにどのミーティングが紐づくかは SpacetimeDB の `group_call` 行が真実源 |
| `infra` | Cloudflare リソースの IaC（Alchemy v2）。Alchemy / Effect への依存はこのディレクトリに隔離し、アプリコードには漏らさない（デプロイ手順は後述） |

## 同期方式

サーバー権威（server-authoritative）モデルです。

- **クライアントは入力のみを送信** します。位置や速度は一切送りません。クライアントは
  `submit_inputs` リデューサーへ、`packInput` で u8 のビットフラグにパックした入力バッチを
  送ります（`INPUT_FLUSH_INTERVAL_MS` 間隔、`INPUT_BATCH_MAX_TICKS` ティックごとに分割）。
- **サーバーが共有物理で再生** します。サーバーは `packages/shared` の決定論的な
  `stepPlayer` を使い、受け取った入力を権威状態（`player` 行）へ適用します。`row.tick` が
  適用済みティック数となり、行の更新そのものがクライアントへの ack になります。
- **クライアント予測 + reconciliation（リプレイ）**。クライアントはローカルで同じ物理を
  即座に実行して予測描画し、各ティックの予測状態を保持します。サーバーから ack 行が届くと、
  対応するティックの予測状態と権威状態を厳密に比較します。
  - 一致すれば、そのティックまでの履歴を破棄して確定（reconciliation 不要）。
  - 不一致（または予測が残っていない）なら、権威状態から未 ack の入力を `stepPlayer` で
    再生して現在ティックまで巻き戻し→再構築し、`resetLocal` で描画をスナップします。
  決定論的物理のため、正直なプレイでは予測と権威は毎回ビット単位で一致し、reconciliation は
  発生しません。
- **ガード**。サーバーは入力バッチの受理判定を `packages/shared` の純関数
  `evaluateInputBatch` で行います（ユニットテスト済み）。検証内容は、バッチサイズが
  `INPUT_BATCH_MAX_TICKS` 以内であること、`startTick === row.tick`（順序どおり・重複で
  ないこと）、そして**トークンバケット式のレート制限**です。ティックの割り当ては実時間に
  沿って貯まり（残高の上限は `MAX_TICK_BANK` ≒1秒分）、バッチを受理するたびにその長さぶん
  消費されます。実時間より `TICK_ALLOWANCE_SLACK` ティックを超えて先行するバッチは拒否
  されるため、持続的な入力レートはちょうどティックレートに制限され、バックグラウンドタブ等で
  遅れた時間を「貯金」して早回しに使うこともできません。不正なバッチは無視され、拒否理由が
  サーバーログに記録されます（再送による重複 `startTick` は正常系なのでログしません）。
  クライアント側には `RESEND_TIMEOUT_MS` の再送ウォッチドッグがあり、ack が途絶えると
  未 ack の入力を再送します（`startTick` チェックにより重複送信は無害）。
- **リモート補間はサーバー時刻基準**。リモートプレイヤーのスナップショットは行の
  `updatedAt`（サーバー時刻）でタイムスタンプされ、受信時刻との差の最小値からクロック
  オフセットを推定して描画タイムラインに写します。これにより配送ジッタが補間の間隔を
  歪めません。更新が途切れた場合は最後の権威速度に沿って最大 250ms だけ外挿してから
  静止し、実データ復帰時のズレは減衰オフセットで滑らかに吸収します。
- **切断と再接続**。切断してもサーバーはプレイヤー行を削除せず `online = false` にマークして
  約10分間保持します（期限切れの行は次の `join` 時に掃除されます）。クライアントは identity
  トークンをタブ単位（`sessionStorage`）で保持するため、リロードや瞬断後の再接続では同じ
  キャラクターを同じ位置から再開できます。接続が切れると画面上部にステータスを表示し、
  指数バックオフで自動再接続します。オフラインの行は各クライアントには描画されません。
- **無操作時の自動休止**。`IDLE_DISCONNECT_MS`（既定 15 分。`net.package/idle.ts`）の間
  ユーザー操作（キー・ポインタ・ホイール）がないと、クライアントは自分から接続を閉じて
  休止バナーを表示します。サーバーから見れば通常の切断と同じで、他のプレイヤーからは
  退出に見えます。次の操作で自動的に再接続し、保存済みトークンで同じキャラクターを
  再開します。現行プロトコルは静止中も送信し続けるため、開きっぱなしで忘れられたタブが
  Maincloud の従量エネルギーを消費し続けないための暫定ガードです（本命の対策は
  ROADMAP Phase 2 の「プロトコルのアイドル抑制」）。開発ビルドでは `/?idleMs=3000` の
  ように URL でタイムアウトを短縮できます（E2E の `idle-disconnect.spec.ts` が使用）。

## 確認手順

1. **SpacetimeDB CLIのインストール**
   [https://spacetimedb.com/install](https://spacetimedb.com/install) の案内に従ってインストールします。
   以降の手順は、インストーラが用意する `spacetime` コマンドを前提にしています。
   （GitHub Releases の `spacetime-x86_64-unknown-linux-gnu.tar.gz` を直接展開する場合、
   中身は `spacetimedb-cli` と `spacetimedb-standalone` で `spacetime` は含まれません。
   その場合は以降の `spacetime ...` を `spacetimedb-cli ...` に読み替えてください。
   CI もこの理由で `spacetimedb-cli` を呼んでいます。）

2. **依存関係のインストール**

   ```sh
   pnpm install
   ```

3. **SpacetimeDB の起動**（別ターミナルで実行し、起動したままにしておきます）

   ```sh
   spacetime start
   ```

4. **サーバーモジュールの publish**（リポジトリルートで実行。`spacetime.json` が `packages/server` を指しています）

   ```sh
   spacetime publish kaede --server local --yes
   ```

5. **TypeScript バインディングの生成**

   ```sh
   spacetime generate --lang typescript --module-path packages/server --out-dir packages/client/src/module_bindings
   ```

6. **クライアントの起動**

   ```sh
   pnpm dev
   ```

   [http://localhost:5173](http://localhost:5173) を **ブラウザウィンドウ2つ** で開きます。

7. **操作方法と確認ポイント**

   - 操作方法:
     - `←` `→` で移動。
     - `Space` でジャンプ。
     - `↑` でロープにつかまる／登る。
     - `↓` で降りる（足場の縁ではロープにつかまる）。
     - `↓` + `Space` でワンウェイ足場をすり抜けて降りる。
     - ロープ上で `←` / `→` + `Space` で飛び降りる。
   - 確認ポイント:
     - 一方のウィンドウで動かしたキャラが、もう一方の画面で**補間されて滑らかに動く**こと。
     - ウィンドウを閉じると、**相手の画面からそのキャラが消える**こと。
     - 下から足場をすり抜けて**ジャンプで乗れる**こと（上からは着地し、下からはすり抜ける）。
     - `↓` + `Space` で足場を**すり抜けて降りられる**こと。
     - ロープで**高台（ジャンプでは届かない高さ）に登れる**こと。

8. **型チェック・テスト・lint・静的解析**

   ```sh
   pnpm typecheck         # 全パッケージの tsc --noEmit
   pnpm test              # shared と client のユニットテストを1回の vitest で実行
   pnpm test:coverage     # 同上 + coverage/coverage-final.json を出力
   pnpm lint              # Biome + ImportLint（内部パッケージ境界）の検査
   pnpm lint:imports      # ImportLint のみ実行
   pnpm format            # Biome によるフォーマット適用
   pnpm analyze           # CIと同じ fallow 一式（dead-code / dupes / health / security）
   pnpm analyze:changed   # 変更ファイルだけを fallow で検査（コミット前向け）
   ```

   テストは shared の物理・入力ガード、client の予測・補間・入力・カメラを対象とします
   （`packages/server` はモジュールホスト上でしか動かず単体テストから import できないため、
   テスト対象になる純粋ロジックは `shared` 側に置いています）。
   `fallow health` は `coverage/coverage-final.json` を**必須**とし、無ければエラー終了します。
   `fallow` を直接叩くときは先に `pnpm test:coverage` を実行してください
   （`pnpm analyze` / `pnpm analyze:changed` と CI は込みです）。

9. **E2E スモークテスト（Playwright）**

   ```sh
   pnpm test:e2e
   ```

   ゲスト2ブラウザで「入場→移動同期→停止後の収束」を検証します（`packages/e2e`）。
   Vite の開発サーバーは Playwright が自動起動しますが、**ローカルの SpacetimeDB
   ホストは起動済み・publish 済みが前提**です（手順 3〜4 と同じ。CI の `e2e`
   ジョブも同じ手順を踏みます）。初回はブラウザのインストールが必要です:

   ```sh
   pnpm --filter @kaede/e2e exec playwright install chromium
   ```

   世界は WebGL キャンバスに描画されるため DOM ではアサートできず、テストは
   クライアントが公開する読み取り専用スナップショットフック `window.__kaedeE2E`
   （契約は `@kaede/shared` の `E2EHook`。`GameApp.ts` が開発ビルド限定で設置）で
   プレイヤー位置を読みます。テストは「世界に居るのは自分たち2人だけ」を前提に
   するので、実行前に localhost:5173 を開いている他のタブ・ウィンドウを
   閉じてください（接続中のクライアントが残っていると人数のアサートが失敗します）。

## デプロイ

クライアントは **Cloudflare Workers の静的アセット配信**（Pages ではなく、Cloudflare の現行推奨）で
`https://kaede.kaede-751.workers.dev` に公開します。リソース定義は `infra/` の
**Alchemy v2**（TypeScript ネイティブの IaC。ベータのためバージョンを厳密にピン留め）にあります。
SPA なので存在しないパスへのリクエストは `index.html` にフォールバックします
（`not_found_handling: single-page-application`）。サーバーモジュールの本番 DB は
Maincloud の **`kaede`**（ダッシュボード: https://spacetimedb.com/kaede ）です。

### 通常経路: main マージで自動デプロイ

**`main` に push（マージ）されると CI がそのまま本番デプロイまで行います。人間の
承認ゲートはありません**（`.github/workflows/ci.yml` の `deploy` ジョブ）。

- `ci`（lint / typecheck / test / fallow / バインディングドリフト検査）と `e2e`
  （Playwright スモーク）の**両方が成功したときだけ**デプロイが走ります。
- デプロイ順序は **モジュール publish（Maincloud）→ クライアント（Alchemy）**。
  スキーマ変更は互換（additive）が原則なので旧クライアントは新スキーマでも動き続け、
  逆順で新クライアントだけが先に出る事故を避けます。非互換なスキーマ変更は
  `publish` 自体が失敗して CI が止まるのが安全装置です。
- 変更の有無にかかわらず毎回デプロイします（Alchemy はビルドをメモ化しており、
  変更がなければ実質何もしない冪等な操作です）。
- デプロイ後、Alchemy のステート差分（`infra/.alchemy/state/kaede/prod/`）を
  CI が実行中の ref（通常は `main`）へ自動コミット・push します。この push は
  `GITHUB_TOKEN` によるものなのでワークフローを再起動しません。
- 同時実行: `ci` / `e2e` は従来どおり新しい push が古い実行をキャンセルしますが、
  **`deploy` ジョブだけはキャンセルされず直列にキュー**されます（デプロイ途中の
  キャンセルは「モジュールだけ新しい」等の中途半端な状態を残すため）。
- 必要なシークレット（GitHub Actions の Secrets）: `CLOUDFLARE_API_TOKEN`・
  `SPACETIMEDB_TOKEN`・`VITE_CLERK_PUBLISHABLE_KEY`（本番 Clerk の
  pk_live_。ローカルの pk_test_ と混ぜないこと — `ci.yml` の deploy ジョブの
  コメント参照）。
- 手動で再デプロイしたいときは、GitHub Actions から **CI ワークフローの
  `workflow_dispatch` を `main` で実行**します（空コミット不要）。`main` 以外の
  ref で dispatch した場合はチェックだけ走り、デプロイはスキップされます
  （main のレビューを迂回して本番へ出す経路を作らないため）。

### 手動デプロイ（逃げ道）

CI を経由できない・したくないとき（Actions 障害、緊急ロールバック等）のための手順です。

1. **前提**

   - 環境変数 `CLOUDFLARE_API_TOKEN`（必要権限: Account / Workers Scripts:Edit と
     User / User Details:Read・Memberships:Read、および Zone:Read。カスタム
     ドメイン `kaede.town` の紐付けはアカウントレベルの Workers Custom
     Domains API が DNS レコードと証明書ごと面倒を見るため、この権限で足りる
     — 2026-08-04 に現行トークンで attach 成功を実測。Zone / DNS:Edit は
     Workers には不要だが、**Clerk 用 CNAME（`clerk.kaede.town` 等）を API /
     IaC で管理したい場合は別途必要**。R2 権限は不要）。
     アカウント ID はシークレットではないため `infra/alchemy.run.ts` と
     `infra/wrangler.jsonc` に直接書いてあり、環境変数は不要です。
   - Node 22.18 未満では TS の型ストリッピングにフラグが要ります。`infra` の
     `deploy:prod` / `plan:prod` / `destroy:prod` と汎用の `alchemy` スクリプトが
     `NODE_OPTIONS=--experimental-strip-types` を設定済みなので、スクリプト経由で
     実行する限り気にする必要はありません。

2. **クライアントのデプロイ（Alchemy）**

   ```sh
   pnpm --filter @kaede/infra deploy:prod          # plan を表示して確認後に適用
   CI=true pnpm --filter @kaede/infra deploy:prod --yes   # CI など非対話環境（env 認証 + 自動承認）
   ```

   デプロイはクライアントのビルド（`pnpm --filter @kaede/client build`）込みです。
   `pnpm --filter @kaede/infra plan:prod` で差分のプレビューだけもできます。
   （スクリプト名が `deploy` ではなく `deploy:prod` なのは、`pnpm deploy` が
   pnpm の組み込みサブコマンドと衝突してスクリプトが実行されないためです。）
   prod 以外のステージや他の alchemy サブコマンドは、ワークアラウンド
   （型ストリッピングのフラグ等）込みの汎用スクリプト経由で実行します。
   素の `pnpm exec alchemy` や `npx alchemy` は Node 22.18 未満で失敗します:

   ```sh
   pnpm --filter @kaede/infra alchemy plan --stage dev_yourname
   ```

   prod 以外のステージは `kaede-<ステージ名のスラッグ>` という別の Worker に
   デプロイされるため、本番 Worker（`kaede`）には触れません。

3. **手動デプロイの逃げ道（wrangler）**

   Alchemy が使えないとき（ベータ起因の不具合など）は、同じ Worker に wrangler で直接
   デプロイできます。設定は `infra/wrangler.jsonc`（`alchemy.run.ts` と同じ構成。乖離させないこと）。

   ```sh
   pnpm --filter @kaede/client build
   cd infra && npx wrangler deploy --config wrangler.jsonc
   ```

   wrangler で上書きした後も、次の Alchemy デプロイがそのまま再収束します（検証済み）。

4. **Alchemy のステート管理**

   ステートは**ローカルファイル（`infra/.alchemy/state/`）に置き、git にコミットして共有**します。
   CI の自動デプロイはデプロイ後にステート差分を自動でコミット・push しますが、
   **手動で Alchemy デプロイした場合はステート差分を自分でコミット**してください
   （放置すると次の CI デプロイのステートコミットと混ざります）。
   リモートストアを選ばなかった理由: R2 バックエンドは API トークンに R2 権限がなく使えず、
   Durable Objects ベースの `Cloudflare.state()` も初回ブートストラップが Secrets Store の
   書き込み権限を要求するため、Workers Scripts:Edit しか持たない現行トークンでは動きません。
   個人用 dev ステージ（既定の `dev_$USER`）のステートは `.gitignore` で除外しています。

   > **注意**: Alchemy のステートには `Redacted` なシークレットも**平文で**書かれます。
   > 現在のスタックにシークレットは含まれませんが、将来スタックにシークレットを足すときは
   > このステート戦略（git コミット）を先に見直してください。

5. **Maincloud へのモジュール公開**

   本番 DB は Maincloud の **`kaede`**（2026-08-02 に `maple-like` として公開、
   2026-08-04 に改名 — rename は identity を変えない）。クライアントの
   既定 DB 名と一致しているため、ビルド時の環境変数は現状不要です。
   通常は CI が publish するので手動操作は不要ですが、手動で行う場合:

   ```sh
   spacetime login                                        # 初回のみ（CI 等では login --token）
   spacetime publish kaede --server maincloud --yes  # リポジトリルートで実行
   ```

   TypeScript バインディングは生成済みのものがリポジトリに含まれているため、デプロイ時に再生成する必要はありません。
   別名の DB に向けたいときは、クライアントのビルド時に `VITE_SPACETIME_DB=<DB名>` を
   設定します（`VITE_SPACETIME_URI` は本番ビルドの既定が `wss://maincloud.spacetimedb.com`
   なので、Maincloud を使う限り設定不要です）。

### 通話 API Worker（kaede-call）

ビデオ通話（ROADMAP Phase 4）の RealtimeKit 呼び出しのうち、シークレットを要する
**ミーティング作成・参加トークン発行**だけを行う Worker です（`packages/worker`）。
CI の自動デプロイに含まれ、リソース定義は `infra/alchemy.run.ts` の `CallApi`、
wrangler の逃げ道は `infra/wrangler-call.jsonc` です。

- **ランタイムシークレット `REALTIMEKIT_API_TOKEN`**（Realtime Admin 権限の
  アカウント API トークン）は **Alchemy のバインディングにしていません** —
  Alchemy のステート（prod は git コミット対象）は `Redacted` 値も平文で保存する
  ことを実測済みのため（2026-08-05）。CI のデプロイジョブが Alchemy デプロイ後に
  `wrangler secret put` で毎回同期します（GitHub Actions シークレット
  `REALTIMEKIT_API_TOKEN` が必要）。Alchemy のスクリプト再アップロードは帯域外の
  secret_text バインディングを保持します（同日実測）。手動で入れ直す場合:

  ```sh
  cd infra && printf '%s' "$REALTIMEKIT_API_TOKEN" | \
    pnpm exec wrangler secret put REALTIMEKIT_API_TOKEN --name kaede-call
  ```

- **ローカル開発**は Alchemy を通さず `wrangler dev` で動かします。
  `infra/.dev.vars`（gitignore 済み — wrangler は設定ファイルの隣の
  `.dev.vars` を読み、同名の vars を上書きする）に **5 つとも**書くこと —
  `wrangler-call.jsonc` の vars は本番値なので、上書きしないと CORS が
  localhost を拒否し、ミーティングも本番アプリに作られてしまいます:

  ```ini
  REALTIMEKIT_API_TOKEN=<Realtime Admin トークン>
  REALTIMEKIT_APP_ID=<ローカル開発用アプリ kaede-dev の ID>
  CLERK_ISSUER=https://<開発インスタンス>.clerk.accounts.dev
  SPACETIME_HOST_URL=http://localhost:3000
  ALLOWED_ORIGINS=http://localhost:5173
  ```

  ```sh
  cd infra && pnpm exec wrangler dev --config wrangler-call.jsonc --port 8787
  ```

  クライアントの開発ビルドは既定で `http://localhost:8787` を呼びます
  （`VITE_CALL_API_URL` で上書き可能。本番ビルドの既定は
  `https://kaede-call.kaede-751.workers.dev`）。

- 通話の**状態は SpacetimeDB が真実源**です: どのグループにどのミーティングが
  紐づくかは `group_call` 行（メンバー限定 RLS）、Worker は「kaede の
  アイデンティティであること」だけを検証します — サインイン済みメンバーは
  Clerk JWT（JWKS 検証）、ゲストは SpacetimeDB ホスト発行のセッショントークン
  （`SPACETIME_HOST_URL` の `/v1/identity/public-key` に対する署名検証 —
  増分②でメンバー限定を解除、ROADMAP Phase 4 参照）。ゲストも通話の開始・
  参加・画面共有をメンバーと同等にできます。

## CI

`main` への push と各 pull request で **CI** ワークフローが走り、lint（Biome）・typecheck・test（カバレッジ付き）・
build・fallow（dead-code / dupes / health / security）に加えて、バージョンを固定した CLI
（`spacetimedb-cli generate`）の再実行によりコミット済み
TypeScript バインディングがサーバースキーマとずれていないことを検証します。並行して
`e2e` ジョブが Playwright のスモークテストを実行します。同一ブランチへの連続 push は
古い実行（`ci` / `e2e` ジョブ）をキャンセルしますが、`main` ではその後に続く
`deploy` ジョブだけはキャンセルされず直列にキューされます（デプロイの節を参照）。

## やらないこと（このフェーズの範囲外）

- **見た目は単色矩形のみ** です。スプライトやアニメーションは含みません。
- **ラグ補償（lag compensation）や巻き戻し当たり判定** は未実装です。本フェーズはクライアント予測と
  reconciliation までを対象とします。
