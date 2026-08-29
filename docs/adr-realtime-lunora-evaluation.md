# ADR: SpacetimeDB 代替候補としての Lunora 評価

- **ステータス**: **評価のみ（2026-08-29）— 移行しない。将来の判断材料として記録**。
  「仮に SpacetimeDB をやめる場合の移行先として Lunora はどうか」というオーナーの
  問いに対する評価。SpacetimeDB 継続の既決（VISION 技術方針表・2026-08-02）は不変
- **対象**: kaede の同期基盤（リアルタイム位置同期・チャット・RLS・procedure）
- **最終更新**: 2026-08-29

---

## 1. 結論

**方向性としては kaede に最も筋のいい移行先候補だが、現時点で移行はしない。**

理由は 2 つ:

1. **Lunora 自身がアルファ段階**（公式 FAQ が「API はリリース間で壊れる。1.0 まで
   収益を載せるな」と明言。プレリリースはシム無しで旧コードパスを落とす方針）。
   kaede は既にコミュニティが oVice から移行して常用する本番プロダクトであり、
   この前提だけで現時点では不適格。
2. **移行で解決される問題が現時点でほぼ残っていない**。コスト懸念はアイドル抑制
   （Phase 2、実測 移動中 2.4〜2.5 calls/秒・静止中 0）で対処済みの見込みで、
   Maincloud の実測（[dogfooding.md](./dogfooding.md) §6）はまだ集計中。
   問題が実測される前に、Phase 0〜3 で積んだ同期層の資産を捨てる理由がない。

ただし「SpacetimeDB をやめる」事態が実際に来た場合、Lunora は
**素の Durable Objects と並ぶ二大候補**になる（§5 の再検討トリガー参照）。

---

## 2. Lunora とは（2026-08-29 時点の調査）

[lunora.sh](https://lunora.sh/) / [GitHub anolilab/lunora](https://github.com/anolilab/lunora)

- **Convex の DX を自分の Cloudflare アカウント上で再現するフレームワーク**。
  TypeScript でスキーマ・query・mutation・action を書くと、SQLite バックの
  Durable Object（ハイバネーション WebSocket）がリアルタイム購読を配信する。
  query は全部購読で、mutation が全クライアントへ push する
- `shardBy(key)` でユーザー/テナント/ルーム単位のシャーディング、`.global()` で
  読み取りのグローバル複製。既定は単一 DO
- codegen による E2E 型付け（サーバー関数 → クライアントの型伝播、ドリフトは
  コンパイルエラー）
- 同梱: Better Auth ベースの認証、Stripe ファーストの課金、R2/KV/Queues/
  Workflows の型付きファサード、ローカル Studio（スキーマ・データ・SQL・
  タイムトラベル）、30 日のポイントインタイム復元
- **ライセンスは FSL-1.1-Apache-2.0**（ソース公開、各リリースは一定期間後に
  Apache-2.0 へ転換）。Lunora 運営のクラウドは存在せず**セルフデプロイのみ**
  （請求は Cloudflare から直接）
- **成熟度: アルファ**。全パッケージ 1.0.0-alpha 系（npm は `lunorash@alpha`）。
  リポジトリは 2026-05 開始・Star 223（2026-08-29 時点）。1.0 ロードマップは
  進行中で、コア 13 パッケージ（server / runtime / do / client / codegen / cli /
  vite / d1 / react 等）に SemVer コミットを付ける計画まで確認できた

---

## 3. kaede との相性がいい点

| # | 観点 | 内容 |
|---|---|---|
| A1 | **Cloudflare 集約方針に合致** | ホスティング・RealtimeKit・R2・AI Gateway は既に Cloudflare（VISION の「エコシステム統合」判断）。同期基盤まで自アカウントに入れば請求・観測・IaC（Alchemy）が完全に一系統になる |
| A2 | **RTT** | VISION が注記する「体感を左右するのはブラウザ↔SpacetimeDB の RTT（Maincloud のリージョン依存）」に対し、DO は初回アクセス地の近くに配置されるため日本ユーザーには構造的に有利 |
| A3 | **「全部 TS・型で縛る」思想と一致** | スキーマ→codegen→クライアントの型伝播は SpacetimeDB の bindings 生成と同型。ドリフト検査の CI 文化をそのまま持ち込める |
| A4 | **コスト構造** | DO はアイドル時ほぼ $0・TeV のような独自課金単位なし。「常時接続オフィス」には DO の課金モデルの方が素直（Phase 2 で月 $300 級の egress 試算からアイドル抑制を実装した経緯そのものが消える） |
| A5 | **外部 HTTP** | action から外部 API を呼べるため、Phase 4 増分⑥で procedure に集約した RealtimeKit/R2 呼び出しの構造（権威と外部境界の同居）はそのまま翻訳できる。WebCrypto が使えるので純 TS HMAC/SigV4 の自前実装（shared の s3.ts）も不要になる |
| A6 | **Phase 6 のスケール戦略と対応** | 「1組織=1DB」の有力方向（ROADMAP Phase 6 の不変条件 2 つ）と `shardBy('org')` が自然に対応。シャーディングが最初から設計に入っている点は、1 DB=1 ノード垂直スケールの SpacetimeDB より SaaS 期に有利 |

---

## 4. 相性が悪い点・移行で失うもの

| # | 観点 | 内容 |
|---|---|---|
| B1 | **アルファ品質（最重要）** | §1 のとおり。本番コミュニティを載せる段階ではない |
| B2 | **ネットコード資産が乗るか未検証** | kaede の核は「サーバー権威の決定論物理＋クライアント予測＋ reconciliation」（Phase 0）で、400ms バッチの入力リプレイをリデューサー内で回す。Lunora は Convex 型のリアクティブ document DB で、想定ユースはイベント駆動 CRUD（Kanban・チャット・チェス）。mutation 内で物理リプレイを回すこと自体は可能でも、移動中 2〜3 calls/秒/人 × 50 人の書き込み頻度での SQLite 書き込み＋購読 push のレイテンシ・課金は全部実測し直しになる。Lunora の optimistic writes / offline queue は kaede の自前予測とは別物で、むしろ切って使うことになる |
| B3 | **RLS 相当の再実装** | DM・クローズド会話・group_call の可視性は SpacetimeDB の `clientVisibilityFilter`（行レベル購読フィルタ）に全面依存。Lunora は query が任意の TS 関数なので表現力はむしろ高いが、「購読の seed・行イベントの両方で非メンバーに 1 行も届かない」ことの E2E 再証明（Phase 3 増分④でやったこと）を全部やり直す |
| B4 | **書き換え範囲はほぼ全層** | `packages/server` 全体、クライアントの `module_bindings`・`net.package`（接続ライフサイクル・購読張り替え・AoI）、E2E の SQL シード基盤、バックアップ運用、CI のデプロイフロー。作業規模は「Phase 0〜3 の同期層をもう一度作る」に近い |
| B5 | **Identity 移行** | Clerk 続投なら iss+sub は不変で、`account` テーブルの再リンク設計（VISION のガードレール — 内部 ID 主キー＋ Identity マッピング）のおかげでユーザー移行自体は可能。ただし SpacetimeDB Identity に依存する全テーブル（player 系・space_member 等）のキー設計は作り直し |
| B6 | **コミュニティ規模・持続性** | 開始 3 ヶ月・Star 223・実質単一メンテナ級。FSL なのでフォーク権はあるが、バス係数は SpacetimeDB（企業・調達済み）より明確に劣る |

---

## 5. 再検討トリガー

SpacetimeDB をやめる動機になり得るのは次の 3 つ（VISION/ROADMAP の経緯から）:

| # | トリガー | 出所 |
|---|---|---|
| T1 | ドッグフーディング実測（[dogfooding.md](./dogfooding.md) §6 — 集計中）で Maincloud の料金が Pro 枠に収まらない、または日本からの RTT が補間・プロトコル調整で吸収できない | ROADMAP Phase 2 |
| T2 | Maincloud 自体の事業継続リスク（サービス終了・大幅値上げ等） | — |
| T3 | Phase 6 で 1組織=1DB のテナント分割を進める際、Maincloud のマルチ DB 運用の原価・管理が合わない | ROADMAP Phase 6 |

**判断枠組み**: T1/T3 が現実になった時点で Lunora が 1.0 に到達していれば
**第一候補**。していなければ「**素の Durable Objects ＋ 自前の薄い同期層**」が
対抗（kaede は予測・補間・入力ガード・接続ライフサイクル状態機械を既に
`@kaede/shared` / `net.package` に自前で持っており、フレームワークなしでも
移行可能 — その場合 Lunora の価値であるリアクティブ購読・codegen・Studio を
チャット/ステータス系にだけ使う選択肢もあるが、2 系統保守になるため劣後）。

逆に、**§6 の実測が Pro 枠内に収まる限り、移行の動機は当面発生しない**。

---

## 6. 監視項目（低コストで追うもの）

- Lunora の 1.0 到達（[GitHub リリース](https://github.com/anolilab/lunora)）と
  その後の破壊的変更の頻度
- dogfooding §6 の Maincloud 実測（T1 の判定材料 — 既存タスク）
- SpacetimeDB 側の対抗進化（シャーディング・リージョン追加等が入れば
  T3 の前提も変わる）
