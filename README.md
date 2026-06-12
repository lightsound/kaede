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
| `packages/server` | SpacetimeDB モジュール（`player` テーブルと `update_position` リデューサー） |

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

   - 操作方法: `←` `→` で移動、`Space` または `↑` でジャンプ。
   - 確認ポイント:
     - 一方のウィンドウで動かしたキャラが、もう一方の画面で**補間されて滑らかに動く**こと。
     - ウィンドウを閉じると、**相手の画面からそのキャラが消える**こと。

8. **型チェックとテスト**

   ```sh
   pnpm typecheck   # 全パッケージの tsc --noEmit
   pnpm test        # shared の物理シミュレーションのユニットテスト
   ```

## やらないこと（このフェーズの範囲外）

- **クライアント予測 / サーバー検証** は次フェーズで対応します。現状はサーバーが受け取った位置をそのまま反映します。
- **見た目は単色矩形のみ** です。スプライトやアニメーションは含みません。
