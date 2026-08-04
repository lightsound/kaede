# ドッグフーディング開始ランブック

実ユーザー投入（ROADMAP Phase 2 の実測開始）までの残作業を、依存順に一本の
チェックリストにしたもの。**ドメインと Clerk 本番 issuer は、実ユーザーが本番で
ログインした瞬間から実質変更不可**（Identity が issuer から導出される — VISION
参照）なので、URL を人に渡す前にここを全部通すこと。作成 2026-08-04。

## 0. 前提の現在地（2026-08-04 更新）

| 項目 | 状態 |
| --- | --- |
| issuer ゲート②（未登録 issuer 拒否） | ✅ 完了（2026-08-02、触らない） |
| エラー監視（PostHog） | ✅ 完了（2026-08-04、再導入しない） |
| バックアップ・復旧手順 | ✅ PR #42 マージ済み（`docs/backup-restore.md`。削除ロック・日次エクスポート稼働） |
| kaede.town | ✅ 取得済み（オーナー購入）・Workers に紐付け済み（PR #43。https://kaede.town 200 を実測） |
| Clerk 本番インスタンス | ✅ 作成済み（production_domain: kaede.town、issuer = `https://clerk.kaede.town`）。JWT テンプレート・許可オリジン設定済み |
| issuer ゲート① | ✅ PR #44 マージ・デプロイ済み。**本番で実測**: 開発 issuer（accepted-toucan-79）の member トークンは接続拒否（module log に記録）・ゲストは従来どおり入場可 |
| 本番クライアントのサインイン導線 | ✅ 開通（2026-08-04）— Clerk 証明書発行済み・Google OAuth 本番設定済み（同意画面も In production）・pk_live_ 焼き込みを実測 |
| 初代管理者 | ✅ 確保（2026-08-04）— オーナーが本番 issuer でサインイン → 申請 → 入場。`space_member` に approved/admin 1 行を実測確認 |
| Maincloud プラン | **当面 Free で小規模に試す**（オーナー判断 2026-08-04）。無料枠は月 2,500 TeV — 実測（§6）でエネルギー消費を見ながら Pro 化を判断。オートポーズは接続で 1 秒未満の自動再開なので小規模運用では実害なし |

**残タスク**（⏸️ **保留中 — 2026-08-04 オーナー判断**: 実際に試用した結果、
現状の機能セットでは常用に至らないため、作り込み（Phase 3 以降）を進めてから
再開する — VISION 決定ログ参照）:
1. URL のコミュニティ共有（オーナー。共有した日＝実測の起点）
2. 共有から数日〜2週間の実測（§6。別セッションで集計）

**UX メモ（2026-08-04、初代管理者ブートストラップ）**: サインイン直後の
オーナーに出る「メンバーとして参加できます／参加を申請する」バナーは、
それを押すことが初代管理者になる正規の手順だが、文言からはそう読めず
「管理者なのに参加ボタンが出ている」ように見えた（実運用で確認）。
→ **解消済み（同日）**: 申請がスペース初（＝管理者シード）になるときだけ
文言を「まだメンバーがいません。最初に参加した人が管理者になります／
管理者として参加する」に切り替える（`membershipPrompt` の `apply-first`。
判定はサーバーの `count() === 0` を公開ディレクトリでミラー — 単体テスト済み）。
Phase 6 の組織作成フローでは作成者を初期管理者として明示する設計にする。

## 1. ドメイン取得（オーナー操作）

1. Cloudflare アカウント「Kaede」(`751c8a59858c9c04a8e722df7330444d`) の
   Registrar で **kaede.town** を購入する（先取りされていたら VISION どおり
   別候補を選び直し、PR #43/#44 の値を差し替える）。
2. Registrar 取得ならゾーンは自動でアカウントに入る。
3. CI / 手動デプロイ用の `CLOUDFLARE_API_TOKEN` にゾーン権限を追加する
   （最低 Zone:Read。Alchemy に DNS・証明書を任せるので Zone / DNS:Edit と
   Workers Routes:Edit を推奨）。GitHub Actions の secret と Cloud Agents の
   secret の両方を更新。
4. **PR #43 をマージ** → CI デプロイで `https://kaede.town` が配信される
   （workers.dev は併存 — 移行中 URL）。

## 2. Clerk 本番インスタンス（Stripe Projects、オーナーのブラウザ認証が要る）

Stripe CLI はこの環境ではブラウザ認証が必要（`stripe login --non-interactive`
で `browser_url` と `verification_code` が出るので、オーナーが完了させる）。

1. `stripe projects status` で現状の Clerk リソース名を確認する。
2. 既存 Clerk リソースに production 環境（`production_domain`）が無いことを
   確認し、**作り直す**（プロビジョニング後の設定変更は不可 — ROADMAP）。
   `stripe projects catalog clerk --json` で正確なスラッグを確認してから:
   `stripe projects remove <既存リソース>` → `stripe projects add clerk/<サービス> --config '{"app_name":"kaede","production_domain":"kaede.town"}'`。
   **⚠️ 削除はオーナー確認のうえ**。
3. **⚠️ 作り直しは開発インスタンスも新しくなる**（新しいアプリになるため）。
   波及先を同じタイミングで全部更新する:
   - 新しい開発 issuer（`https://<新スラッグ>.clerk.accounts.dev`）を
     PR #44 の `CLERK_DEVELOPMENT_ISSUER` に反映
   - 新しい pk_test_ を各自のローカル `.env` に（`stripe projects env --pull`）
   - 新しい sk_test_ を Cloud Agents の `CLERK_SECRET_KEY` secret に
   - 開発インスタンスにも JWT テンプレート `spacetimedb` を作り直す（下記 5.）
4. `dns_setup_url` から Clerk 用 DNS（`clerk.kaede.town` 等の CNAME）を設定する。
   Cloudflare 側は **DNS only（プロキシ無効）** にすること。アプリ用 DNS
   （Workers カスタムドメイン、Alchemy 管理）とは別物で両方必要。証明書発行まで
   待って dashboard の DNS チェックを通す。
   必要なレコードは確定済み（2026-08-04、Clerk API `GET /v1/domains` で取得。
   CI の API トークンは DNS:Edit を持たないためオーナーがダッシュボードで追加
   するか、トークンに Zone / DNS:Edit を足してエージェントに任せる）:

   | Type | Name | Target |
   | --- | --- | --- |
   | CNAME | `clerk` | `frontend-api.clerk.services` |
   | CNAME | `accounts` | `accounts.clerk.services` |
   | CNAME | `clkmail` | `mail.g0p7xy4ozs5m.clerk.services` |
   | CNAME | `clk._domainkey` | `dkim1.g0p7xy4ozs5m.clerk.services` |
   | CNAME | `clk2._domainkey` | `dkim2.g0p7xy4ozs5m.clerk.services` |
5. 本番インスタンスに JWT テンプレート `spacetimedb` を Backend API で作成する。
   開発側の既存テンプレートを GET して同じ内容を POST するのが確実
   （aud: `kaede-spacetimedb`、寿命 60 秒、`"name": "{{user.full_name}}"`）:

   ```sh
   # 開発側から複製元を取る（sk_test_）
   curl -s https://api.clerk.com/v1/jwt_templates -H "Authorization: Bearer $SK_TEST"
   # 本番へ作成（sk_live_）
   curl -s -X POST https://api.clerk.com/v1/jwt_templates \
     -H "Authorization: Bearer $SK_LIVE" -H "Content-Type: application/json" \
     -d '<開発側と同じ name/claims/lifetime の JSON>'
   ```

6. Google ログインを本番に揃える。**本番インスタンスは Clerk の共有 OAuth
   資格情報を使えない**ので、Google Cloud Console で OAuth クライアントを作成
   してオーナーが設定する（リダイレクト URI は Clerk が指示する
   `https://clerk.kaede.town/v1/oauth_callback`）。
7. 許可オリジン／リダイレクトに `https://kaede.town` と、切替中に使う
   `https://kaede.kaede-751.workers.dev` を入れる。
8. **実 issuer を実測で確認**: 本番インスタンスでサインインしてトークンの `iss`
   が `https://clerk.kaede.town` であることを確認（違ったら PR #44 の
   `CLERK_PRODUCTION_ISSUER` を修正）。
9. pk_live_ を GitHub Actions secret `VITE_CLERK_PUBLISHABLE_KEY` に登録する
   （ローカル用 pk_test_ と混ぜない）。**sk_live_ はクライアントにも git にも
   どのシークレットストアにも入れない** — JWT テンプレート作成など Backend API
   の一時利用のみ。

## 3. Maincloud を常用に耐える状態へ（オーナー操作）

- Free 枠（2,500 TeV/月）は常時接続オフィスに不足＝ **Pro（$25/月、
  100,000 TeV 込み）へアップグレード**し、支出上限を設定する（ROADMAP の
  試算: アイドル抑制込みで月 5〜7.5万 TeV ≒ Pro 枠内）。
- Free のままだと無活動時にオートポーズされる点も常設オフィスと相性が悪い。

## 4. 切替デプロイ（PR #44 のマージ）

PR #44 のマージ前提チェックリスト（PR 本文）を全部満たしてからマージする。
モジュールの issuer 差し替えとクライアントの pk_live_ 注入が同一デプロイで出る。

## 5. 初代管理者の先取り（オーナー操作、URL 共有前に必ず）

デプロイ完了直後に、オーナー自身が本番 issuer でサインイン →「参加を申請する」。
空のデータベースでは最初の申請者が管理者になる（`initialMembership`）。
workers.dev の URL でもよい（Identity は issuer から導出されるので、本番
Clerk でサインインする限り本番側の Identity になる）。あわせて
**サインイン → JWT テンプレート経由で接続 → 申請 → 入場**の一連をオーナーが
確認する。**開発 Clerk の Identity で実メンバーを入れないこと**（切替時に
全アカウントの Identity 付け替えになる）。

ここまで通ったら URL をコミュニティに共有してよい。ROADMAP Phase 2 の
「ドッグフーディング開始」を ✅ にする PR を出す。

## 6. 実測（開始後 数日〜2週間、別セッション可）

| 項目 | 見るもの・やり方 | 判断基準 |
| --- | --- | --- |
| Maincloud 利用料金 | Maincloud ダッシュボードのエネルギー消費（日次で記録） | 月換算で 5〜7.5万 TeV ≒ Pro 枠 100,000 TeV 内か（$1≒2,592 TeV、egress 2,000 TeV/GB、ストレージ $1/GB/月）。超えるなら ROADMAP の変化点駆動へのエスカレーションを検討 |
| エネルギー内訳の CPU 命令数 | 同ダッシュボードの内訳 | CPU が支配項なら「クライアント権威＋サーバー側クランプ」への縮退を再検討（ROADMAP Phase 2） |
| 日本からの RTT | `curl -o /dev/null -s -w 'connect %{time_connect}s ttfb %{time_starttransfer}s\n' https://maincloud.spacetimedb.com/v1/ping` を日本の回線から数回。体感は入力→リモート反映の遅延 | 問題があれば補間・プロトコル側の調整で吸収（セルフホストは 2026-08-04 に選択肢から除外 — VISION 決定ログ） |
| PostHog の広告ブロッカー欠落率（ADR §9-6） | サーバー側 `connection_event`（member の connected 件数 — `spacetime sql` で日次集計）と PostHog の `spacetimedb_connected` 件数の差分 | 欠落率が高ければリバースプロキシ（`us.i.posthog.com` を自ドメイン経由に）の要否を判断 |
| エラーグルーピング精度（ADR §9-1） | 最初の 2 週間、PostHog の issue リストで同一バグの分裂／無関係な統合を観察 | 原因究明に時間を取られるようなら ADR §7-4 の見直しトリガー |

`connection_event` の集計例（オーナー実行、RLS 対象外）:

```sh
spacetime sql kaede --server maincloud \
  "SELECT * FROM connection_event WHERE kind = 'connected' AND detail = 'member'" --format json
```

## 付記: パッケージ名整理（⑤、任意）の判断

- **npm スコープ・表示名の改名（`maple-like` / `@maple/*` → kaede 系）は
  PR #42/#43/#44 がマージされるまで保留**する。リポジトリ全域に触る改名を
  今開くと、切替系 PR と広範に衝突するため。切替完了後の静かなタイミングで
  専用 PR にする。
- **Maincloud の DB 名 `maple-like` の改名は別判断**。`spacetime rename` は
  identity を変えないので `PRODUCTION_DATABASE_IDENTITY` ピンはそのまま使える
  が、接続先（クライアント既定値）・CI の publish・バックアップスクリプトの
  既定値に波及するので、やるなら専用 PR＋検証手順で。なお Maincloud には
  過去の実験由来とみられる未使用 DB `kaede`・`kaede-366x1` が同一アカウントに
  既存（2026-08-04 確認）なので、`kaede` へ改名するならその整理が先。
  やらなくてもドッグフーディングは止めない。
