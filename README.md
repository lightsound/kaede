# maple-like

メイプルストーリー風2D横スクロールMMORPGの最小プロトタイプ（MVP）です。
複数のブラウザウィンドウから同じワールドに接続し、互いのキャラクターがリアルタイムに同期して動く様子を確認できます。

## 技術スタック

- **TypeScript** — 全パッケージ共通の言語
- **PixiJS v8** — 2Dレンダリング
- **Vite + React** — クライアントのビルド／開発サーバー（Reactの役割はキャンバスのマウントのみ）
- **SpacetimeDB 2.x** — リアルタイム同期バックエンド（DB兼サーバーロジック）
- **pnpm workspaces** — モノレポ管理

## パッケージ構成

| パッケージ | 説明 |
| --- | --- |
| `packages/shared` | 物理シミュレーション・マップ・定数など、クライアントとサーバーで共有するロジック |
| `packages/client` | PixiJS + React のクライアント（ローカル操作の描画とネットワーク同期） |
| `packages/server` | SpacetimeDB モジュール（`player` テーブルと `submit_inputs` リデューサー。サーバー権威で物理を再生） |

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
   （GitHub Releases の `spacetime-x86_64-unknown-linux-gnu.tar.gz` などのバイナリを直接配置しても構いません。）

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

8. **型チェック・テスト・lint**

   ```sh
   pnpm typecheck   # 全パッケージの tsc --noEmit
   pnpm test        # shared の物理・入力ガード、client の予測・補間のユニットテスト
   pnpm lint        # Biome による lint とフォーマット検査
   pnpm format      # Biome によるフォーマット適用
   ```

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

   - **Root Directory**: `packages/client`（`vercel.json` が install / build / 出力先を定義済み。Framework は Vite として自動検出されます）
   - **Environment Variables**: `VITE_SPACETIME_DB` = Maincloud で付けた DB名。
     （`VITE_SPACETIME_URI` は本番ビルドの既定が `wss://maincloud.spacetimedb.com` なので、Maincloud を使う限り設定不要です）

3. **デプロイ**

   **Deploy** を押せば公開されます。以後、ブランチへ push するたびに Vercel が自動でビルド・デプロイします。
   発行された URL にスマホからアクセスできます（タッチ操作に対応しています）。

4. **CI**

   `main` への push と各 pull request で **CI** ワークフローが走り、lint（Biome）・typecheck・test・build・
   fallow（dead-code / dupes）に加えて、`spacetime generate`（バージョン固定）の再実行によりコミット済み
   TypeScript バインディングがサーバースキーマとずれていないことを検証します。同一ブランチへの連続 push は
   古い実行をキャンセルします。

## やらないこと（このフェーズの範囲外）

- **見た目は単色矩形のみ** です。スプライトやアニメーションは含みません。
- **ラグ補償（lag compensation）や巻き戻し当たり判定** は未実装です。本フェーズはクライアント予測と
  reconciliation までを対象とします。
