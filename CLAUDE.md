# CLAUDE.md

メイプルストーリー風2D横スクロールMMORPG。pnpm monorepo: `packages/shared`（決定論シミュレーション）, `packages/server`（SpacetimeDB TS モジュール）, `packages/client`（PixiJS v8 + React/Vite）。README.md に全体像・確認手順・デプロイ手順がある。

## コマンド

```sh
pnpm install
pnpm typecheck                        # 全パッケージ tsc --noEmit
pnpm test                             # shared + client の vitest
pnpm --filter @maple/client build
pnpm exec fallow dead-code
pnpm exec fallow dupes
```

CI はこの5つを全部実行する。**push 前に5つ全部グリーンであること。**

## 絶対に守る設計不変条件

1. **サーバー権威**: クライアントは u8 にパックした入力だけを送る（`submit_inputs`）。位置・HP・マップ移動などの状態を直接書くリデューサーを追加しないこと。移動・攻撃発火・ポータル移動はすべて shared の `stepPlayer` のリプレイで決まる。
2. **決定論**: `packages/shared` の `stepPlayer` はクライアント予測とサーバーリプレイで**ビット単位一致**が前提（一致しないと毎 tick reconciliation が発生する）。演算順序・定数・分岐を変える変更は挙動変更。シミュレーションに影響する状態を足すときは `PlayerState` + player 行 + `stateFromRow` + prediction.ts の `sameState` の4点セットで追加する。
3. **バインディングは手動管理**: `packages/client/src/module_bindings/` は生成形式を模した手書き（この環境に spacetime CLI が無い前提）。サーバースキーマを変えたら必ず鏡写しに更新し、**カラムの宣言順はワイヤフォーマットそのもの** — 順序がずれると黙ってデシリアライズが壊れる。
4. **リデューサーパラメータの複合型には名前が必須**: 無名の `t.row({...})` をパラメータにすると publish が `Missing type name` で失敗する。`t.row('Name', {...})` で命名し、テーブルと共有する（`mobAiTimerRow` 参照）。
5. **tables.ts ⇄ reducers.ts の循環**: スケジュールリデューサー（`mobTick`）は eager import すると TDZ クラッシュする。`setMobTick` の遅延参照パターンを維持すること。
6. スキーマ変更後は再 publish が必要（多くの場合 `spacetime publish <DB名> --server maincloud --delete-data --yes`）。クライアントとモジュールのスキーマは一致している必要がある。

## 慣習

- コメントは英語で「なぜ/不変条件」を書く（何をしているかの逐語説明は書かない）。README とゲーム内 UI は日本語。
- fallow dupes はペア単位で検出する設定 — コピペせず既存ヘルパー（`physics.ts`, `oscillator.ts`, `smoothing.ts`, `remoteView.ts` の汎用 meta 等）を再利用する。
- ローカル2窓テストは片方を `?guest=1` で開く（identity が localStorage に永続化されるため）。
