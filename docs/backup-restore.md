# バックアップ・復旧手順（Maincloud）

ROADMAP Phase 1「バックアップ・復旧手段の確認」の成果物。**実ユーザー投入
（ドッグフーディング開始）前に必須**の項目で、スキーママイグレーション事故への
保険を兼ねる。調査・実測は 2026-08-04。

## 調査結果: Maincloud 側に頼れるものはない

- Maincloud はインフラとして自動バックアップを持つ（公式 docs の記載）が、
  **利用者向けのスナップショット取得・エクスポート・リストア API は存在しない**。
- SLA は「データ復旧（data restoration）」を提供コミットメントから**明示的に
  除外**している（[spacetimedb.com/sla](https://spacetimedb.com/sla) §5.3 ほか）。
- したがって恒久データの保全は**自前のエクスポート**で行う。

## 何を守るか

| テーブル | 性質 | 復旧の必要性 |
| --- | --- | --- |
| `account` | 恒久（内部 ID ↔ Identity ↔ 表示名） | **必須**。ただし後述のとおり Identity は決定的に再導出される |
| `space_member` | 恒久（承認制の状態機械: pending/approved/rejected/banned、admin ロール） | **必須**。「誰を入れてよいか・誰をバンしたか」はここにしかない |
| `space_setting` | 恒久（ゲスト許可トグル） | 1 行。エクスポートを見て手で戻せる |
| `chat_message` / `dm_message` | 履歴（各 100 / 200 通で間引き済み） | ベストエフォート（消えても運用は止まらない） |
| `player*` / `reaction` / `player_status` / `*_guard` / `connection_event` / `disconnect_intent` | 一時（在室状態・ガード・観測ログ） | 復旧不要（再入場で再生成される） |

## エクスポート（バックアップ）手順

### 手動

```sh
spacetime login --token "$SPACETIMEDB_TOKEN"   # 未ログインの場合
scripts/backup-maincloud.sh                     # backups/<UTC タイムスタンプ>/ に全テーブルの JSON
```

- スクリプトは `describe --json` からテーブル一覧を動的に取得するので、
  スキーマ変更時の追従漏れがない。
- オーナー実行の `sql` は RLS と public フラグを受けないため、非公開テーブル
  （`account` 等）もそのまま読める。
- `backups/` は成果物であり git 管理しない（`.gitignore` 済み）。

### 自動（毎日）

`.github/workflows/backup.yml` が毎日 19:00 UTC（04:00 JST）に全テーブルを
エクスポートし、**GitHub Actions の artifact（保持 90 日）**として保存する。
手動実行は Actions タブの workflow_dispatch から。トークンは deploy ジョブと
同じ `SPACETIMEDB_TOKEN` シークレットを使う。

リストアのリハーサルや危険な操作（非互換マイグレーションのインクリメンタル
移行等）の直前には、**必ず手動エクスポートを取ってから**行うこと。

## 復旧（リストア）手順

### 前提: Identity は DB が消えても変わらない

SpacetimeDB の Identity は **issuer + subject から決定的に導出**される
（Phase 1 スパイクで実測済み — 再接続 2 回で同一 Identity）。データベースを
作り直しても、**同じ Clerk インスタンスでサインインし直せば全員が同じ
Identity に戻る**。復旧が「データの再投入」ではなく「状態の再宣言」で済むのは
このため。逆に言えば、**Clerk インスタンス（issuer）が失われると Identity ごと
失われる** — issuer の変更が実質不可逆である理由（VISION 参照）と同じ制約。

### 手順（全損からの再建）

1. モジュールを publish し直す（CI の main デプロイ、または手動
   `spacetime publish kaedetown --server maincloud --yes`）。
   **データベースを削除→再作成した場合は identity が変わる**:
   `packages/server/src/reducers.ts` の `PRODUCTION_DATABASE_IDENTITY`
   （issuer ゲート①の本番判定ピン）を新しい identity に**同じデプロイで**
   更新すること。古いままだと本番が非本番扱いになり、開発 Clerk issuer が
   member を鋳造できる状態（fail-open）に戻る — 検知は `onConnect` の
   トリップワイヤ warn（module log）。あわせて `spacetime lock` も再適用する
   （ロックは DB 単位なので再作成で外れる）。
2. **URL を共有する前に**、オーナーが本番 issuer でサインイン →「参加を申請する」。
   空のデータベースでは最初の申請者が初代管理者になる（`initialMembership`）ので、
   これで管理者権限が戻る。
3. 直近のエクスポートの `space_member.json` を突き合わせて、管理パネルから
   メンバーシップを再宣言する:
   - `approved` だった人 → 再申請してもらい、承認する
   - `banned` だった人 → 再申請が来た時点で拒否 → バンする
   - `rejected` / `pending` は放置でよい（本人の再申請から通常フロー）
4. `space_setting.json` を見てゲスト許可トグルを合わせる。
5. `account` の表示名は、各メンバーの初回サインインで JWT の `name` クレーム
   から再初期化される。カスタム名にしていた人は各自で再設定
   （`account.json` が参照になる）。

チャット/DM 履歴は再投入しない（間引き前提の短い履歴であり、復旧コストに
見合わない）。

### 行単位のリストアをしない理由（実測 2026-08-04）

- `spacetime sql` の INSERT は動く（identity の 16 進リテラル・日本語文字列とも
  ローカルで確認）が、**optional（Sum 型）カラムを表現できない**
  （`display_name` に文字列も NULL も渡せず、列の省略も「全列必須」で拒否される）。
  `account` / `space_member` はどちらも optional 列を持つため、SQL だけでは
  復元できない。
- 専用のリストア用リデューサーを足す案は MVP では見送り: 空 DB では送信者を
  検証する土台（管理者メンバーシップ）自体が消えているため安全に守れず、
  〜50 人規模なら上記の手動再宣言で十分。持ち物・アバター等の恒久データが
  増える Phase 5 以降で、データ量が手動再宣言に見合わなくなったら再検討する。

## 誤削除・誤操作への予防

- **削除ロック**: `spacetime lock kaedetown --server maincloud` を適用済み
  （2026-08-04、IaC 外の手動操作としてここに記録）。ロック中は
  `spacetime delete` が通らない。解除は `spacetime unlock`。
  なお、ロックが守るのは削除だけで **`publish --delete-data` は防げない** —
  `--delete-data` は CI のデプロイには存在せず、手で打つときは必ず直前に
  手動エクスポートを取ること。
- **非互換スキーマ変更**: CI の publish は互換変更しか受け付けず、非互換なら
  publish 自体が失敗してパイプラインが止まる（ROADMAP のマイグレーション
  運用ルール参照）。事故モードは「手動の `--delete-data`」と「インクリメンタル
  マイグレーションの実装バグ」の 2 つで、どちらも直前の手動エクスポートが保険。
