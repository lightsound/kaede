# maple-like

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
| `packages/server` | SpacetimeDB モジュール（`player` テーブルと `submit_inputs` リデューサー。サーバー権威で物理を再生） |
| `packages/e2e` | Playwright の E2E スモークテスト（ゲスト2ブラウザの「入場→移動同期」をフルスタックで検証） |

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
   spacetime publish maple-like --server local --yes
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
   pnpm --filter @maple/e2e exec playwright install chromium
   ```

   世界は WebGL キャンバスに描画されるため DOM ではアサートできず、テストは
   クライアントが公開する読み取り専用スナップショットフック `window.__mapleE2E`
   （契約は `@maple/shared` の `E2EHook`。`GameApp.ts` が開発ビルド限定で設置）で
   プレイヤー位置を読みます。テストは「世界に居るのは自分たち2人だけ」を前提に
   するので、実行前に localhost:5173 を開いている他のタブ・ウィンドウを
   閉じてください（接続中のクライアントが残っていると人数のアサートが失敗します）。

## デプロイ（公開手順）

ローカルでの動作確認ができたら、Maincloud（SpacetimeDB のマネージドホスト）へモジュールを公開し、
クライアントを Vercel へデプロイすることで、スマホを含む任意の端末からアクセスできます。

1. **Maincloud へのモジュール公開**（お手元で実行）

   ```sh
   spacetime login
   spacetime publish <DB名> --server maincloud --yes   # リポジトリルートで実行。DB名は任意のユニーク名
   ```

   TypeScript バインディングは生成済みのものがリポジトリに含まれているため、デプロイ時に再生成する必要はありません。

   > **注意**: 今回の変更で `player` テーブルのスキーマが変わっています。既存のモジュールがある場合は
   > **再 publish が必須**です。publish が既存データとの非互換を理由に失敗するときは、まだ永続的な
   > 進行データはないので、データを削除して publish し直してください
   > （例: `spacetime publish <DB名> --server maincloud --delete-data --yes`）。ローカル（`--server local`）でも同様です。

2. **Vercel プロジェクトの作成**

   [vercel.com](https://vercel.com) で **Add New → Project** からこのリポジトリを import し、次の2点だけ設定します。

   - **Root Directory**: `packages/client`（`vercel.json` が framework / install / build / 出力先を定義済みなので、追加設定は不要です）
   - **Environment Variables**: `VITE_SPACETIME_DB` = Maincloud で付けた DB名。
     （`VITE_SPACETIME_URI` は本番ビルドの既定が `wss://maincloud.spacetimedb.com` なので、Maincloud を使う限り設定不要です）

3. **デプロイ**

   **Deploy** を押せば公開されます。以後、ブランチへ push するたびに Vercel が自動でビルド・デプロイします。
   発行された URL にスマホからアクセスできます（タッチ操作に対応しています）。

4. **CI**

   `main` への push と各 pull request で **CI** ワークフローが走り、lint（Biome）・typecheck・test（カバレッジ付き）・
   build・fallow（dead-code / dupes / health / security）に加えて、バージョンを固定した CLI
   （`spacetimedb-cli generate`）の再実行によりコミット済み
   TypeScript バインディングがサーバースキーマとずれていないことを検証します。同一ブランチへの連続 push は
   古い実行をキャンセルします。

## やらないこと（このフェーズの範囲外）

- **見た目は単色矩形のみ** です。スプライトやアニメーションは含みません。
- **ラグ補償（lag compensation）や巻き戻し当たり判定** は未実装です。本フェーズはクライアント予測と
  reconciliation までを対象とします。
