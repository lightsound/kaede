# ADR: 全テーブルを cachePolicy: required_in_memory で明示ピンし、SpacetimeDB 3.0 の既定反転に備える

- **ステータス**: **採用（2026-11-27 確定）** — 独立エージェントとの設計相談
  （テーブル全件のデータ特性と SDK 2.16.3 の実装確認を含む）を経て決定
- **対象**: kaede の SpacetimeDB モジュール（packages/server の全テーブル）
- **最終更新**: 2026-11-27

---

## 1. 決定

**全25テーブルの `cachePolicy` を `required_in_memory` で明示ピンする。**

SpacetimeDB 3.0 では階層ストレージの cache policy の既定が
`required_in_memory` から `no_requirement` に反転する（ベンダが 2.16.1 の
リリースノートで予告）。何も書かなければ、3.0 への移行の瞬間に全テーブルの
配置方針が暗黙に変わる。全テーブルに現在の既定値を明示しておけば、
3.0 の既定反転は kaede にとって無イベントになる。

実装は `packages/server/src/tables.ts` の各 `table()` 第1引数への
`cachePolicy: 'required_in_memory'` の追加のみ。テーブル単位のインライン
指定とし、共通定数化はしない（既存の `name` / `public` が全てインライン
リテラルであり、将来テーブル単位で方針を変える際に差分がその行だけに
現れる方が監査しやすい。スキーマレベルの一括指定は SDK に存在しない）。

---

## 2. 2.16.3 では差分ゼロであること

SDK 2.16.3 の `table()` 実装では、`cachePolicy` の既定値は
`required_in_memory` であり、この値のときだけモジュール定義の
`tableCachePolicies` に載らない。したがって本変更は:

- モジュール定義（スキーマ）に差分ゼロ
- クライアント bindings に差分ゼロ（policy は bindings に現れない）
- 再 publish 時の Database Migration Plan は空

であることを、bindings 再生成の差分ゼロとローカルホストでの
republish リハーサルで実証してから取り込む。逆に `no_requirement` や
`required_on_disk` を書くと policy がモジュール定義に載り、republish 時の
自動移行対象になる。

---

## 3. 全テーブルをメモリ常駐に留める理由

- **ベンダ自身の移行指示である。** 2.16.1 リリースノートは「3.0 後も
  全メモリの挙動を保ちたいテーブルには `required_in_memory` を明示せよ」
  と案内している。
- **kaede のデータ量は設計上有界で微小である。** 履歴系は行数上限で
  trim される（chat_message 100行 / dm_message 200行 /
  call_recording 200行 / connection_event 10,000行）。残りは在席
  （player 系）、グループ、ガード（トークンバケット）、単一行設定
  （space_setting / call_config）で、いずれも接続中ユーザー数や
  グループ数に比例する有界なデータしか持たない。Maincloud の常駐
  メモリ上限 24 GiB に対して桁違いに小さい。
- **2.16 系のコールド読みには rollback-and-retry が未搭載である。**
  tiering したテーブルへのトランザクションは、コールドデータの
  fault-in を伴う場合の滑らかさがまだ保証されない。レイテンシが
  製品の中核（入力バッチ毎に read+write する player 行、RLS 再評価の
  内側にある会話データ）では、この段階で tiering を入れる理由がない。

テーブル別の位置づけは次の通りで、全て `required_in_memory` とする。

| 区分           | テーブル                                                                                              | 性質                                        |
| -------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| 在席の中核     | player / player_guard                                                                                 | 入力バッチ毎に read+write、レイテンシの中核 |
| 在席の表示物   | player_name / player_status / reaction / gesture                                                      | 在席に追随する表示状態                      |
| グループ・通話 | group_member / conversation_group / group_call                                                        | RLS の JOIN・ゾーン判定の経路               |
| 会話           | chat_message / dm_message                                                                             | 上限 100 / 200 行、RLS 再評価の内側         |
| 一過性         | disconnect_intent                                                                                     | 切断直後だけ生きる行                        |
| ガード7種      | chat_guard / gesture_guard / reaction_guard / status_guard / portal_guard / huddle_guard / call_guard | 送信経路のトークンバケット                  |
| 認証・入室     | account / space_member / space_setting                                                                | 認証と入室判定の経路                        |
| 通話設定・録画 | call_config / call_recording                                                                          | 単一行設定／上限 200 行                     |
| 運用ログ       | connection_event                                                                                      | 上限 10,000 行                              |

---

## 4. 不採用にした選択肢

### 4.1 `required_on_disk`（全テーブルで不採用）

「メモリからは出てよいがローカルディスクには残す」中間案だが、Maincloud
では実質「メモリ常駐か完全 tiering か」の二択であり、中間を取る運用上の
利点がない。将来 tiering が必要になったテーブルは §5 のトリガで直接
`no_requirement` を検討する。

### 4.2 connection_event の `no_requirement` パイロット（不採用）

運用ログで上限も最大（10,000行）という理由で、tiering の実験台候補として
検討した。しかし行が小さく総量も知れているため学習効果が薄く、しかも
その書込みは接続経路（接続のたびに記録される）に乗るため、無リスクな
実験台でもない。パイロットは見送り、必要になった時点で §5 のトリガに
基づいて第一候補として再検討する。

---

## 5. テーブル単位の再検討トリガ

以下のいずれかが真になったら、該当テーブルについて本 ADR を再評価する。

1. **SpacetimeDB 3.0 が rollback-and-retry とともにリリースされた** →
   コールド読みの滑らかさが保証され、tiering の前提が変わる
2. **保持上限の引き上げ・撤廃を検討するとき** → 特に connection_event
   の上限増や監査ログの長期保持を考える場合は、connection_event が
   `no_requirement` 化の第一候補
3. **実測の常駐メモリ量が Maincloud の上限 24 GiB に対して無視できない
   割合になった** → 大きいテーブルから順に tiering を検討する
4. **Phase 6 のマルチテナント化でデータ量が桁で増えた** → 履歴系
   テーブルから順に tiering を検討する
