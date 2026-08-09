// fallow-ignore-file unused-file -- alchemy CLI が直接実行する IaC エントリポイント。アプリのモジュールグラフからは到達しない
// kaede の Cloudflare リソース定義(Alchemy v2)。
//
// このディレクトリの外に Alchemy / Effect を漏らさないこと(docs/VISION.md の
// IaC 行のベータ採用条件)。アプリコードはこのファイルの存在を知らない。
//
// 実行は infra/ を作業ディレクトリとして `alchemy deploy --stage prod` で行う
// (`pnpm --filter @kaede/infra deploy:prod`。素の `deploy` は pnpm の
// 組み込みサブコマンドと衝突するため使わない)。手順の全体は README の
// 「デプロイ(公開手順)」を参照。
//
// スクリプトが `npm_execpath=` を空にしているのは alchemy ランチャーの
// バグ回避: ランチャーは npm_execpath に "bun" が含まれると bun 経由の
// 起動と判定するが、pnpm run 経由ではこの値が pnpm 本体のパスになり、
// 例えば /home/ubuntu/... の「ubuntu」が誤マッチして存在しない bun を
// spawn しようとする(beta.70 の bin/cli.js でも未修正を確認)。環境変数の
// 設定は Windows の cmd.exe でも動くよう cross-env 経由にしている。
import * as Alchemy from 'alchemy';
import * as Cloudflare from 'alchemy/Cloudflare';
import * as Effect from 'effect/Effect';

// アカウント「Kaede」の ID(シークレットではない公開識別子)。API トークンと
// 違い環境変数で配る必要がないため、ここに固定して deploy コマンドの前提を
// 減らす。別アカウントに向けたいときは環境変数が優先される。
//
// beta.70 での注意: この env 固定が効くのは env 認証パス(CI=true +
// CLOUDFLARE_API_TOKEN — CI のデプロイはこちら)だけになった。ローカルの
// 対話実行では auth プロファイルが持つ accountId が優先され、
// CLOUDFLARE_ACCOUNT_ID は読まれない。プロファイルが別アカウントに
// リンクされていると、全リソースが「別アカウントにある」扱いになり plan が
// 偽の replace を出す(R2 は中身ごと消える経路)。このため infra の
// スクリプトはリポジトリ専用プロファイル `kaede`(ALCHEMY_PROFILE=kaede)に
// 固定してあり、初回のみ `pnpm --filter @kaede/infra alchemy login` で
// Kaede アカウント(下の ID)を選んでリンクする。CI は fresh VM で
// プロファイルが存在しないため従来どおり env 認証に落ちる(影響なし)。
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID ?? '751c8a59858c9c04a8e722df7330444d';
process.env.CLOUDFLARE_ACCOUNT_ID = ACCOUNT_ID;

/** 依存なしの安定ハッシュ(FNV-1a 32bit、16進8桁)。スラッグの一意化サフィックス用。 */
const fnv1a = (input: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
};

/**
 * ステージ名を Cloudflare Worker 名に使える形([a-z0-9-])へ正規化する。
 * 正規化が情報を落とした場合(使えない文字を潰した・前後を刈った)は、
 * 元のステージ名の短いハッシュを付けて一意性を守る — dev_john.doe と
 * dev_john-doe が同じ Worker を取り合ったり、全部の文字が落ちて
 * `kaede-`(Cloudflare が拒否する不正な名前)になったりしないように。
 * 正規化で変化しないステージ名はそのまま使う(dev-foo → kaede-dev-foo)。
 */
const workerNameSlug = (stage: string): string => {
  const slug = stage
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug === stage) return slug;
  const suffix = fnv1a(stage).slice(0, 6);
  return slug === '' ? suffix : `${slug}-${suffix}`;
};

/**
 * リソース名のステージ規約: prod は素の名前、それ以外は `-<stage>` を付ける。
 * 固定名にするとステートが分かれていても全ステージが同じ本番リソースを
 * 取り合える(下の Worker 名コメント参照)ため、全リソースで同じ規約を通す。
 */
const stagedName = (stage: string, prodName: string): string =>
  stage === 'prod' ? prodName : `${prodName}-${workerNameSlug(stage)}`;

export default Alchemy.Stack(
  'kaede',
  {
    providers: Cloudflare.providers(),
    // ステートはローカルファイル(infra/.alchemy/)に置き、git にコミットして
    // 共有する。Durable Objects ベースの Cloudflare.state() は初回ブート
    // ストラップが Secrets Store の書き込み権限を要求するため、Workers
    // Scripts:Edit しか持たない現行の API トークンでは使えない。選定理由の
    // 全文は README の「Alchemy のステート管理」を参照。
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage;

    // クライアント(Vite SPA)を「アセットのみの Worker」として配信する。
    // Worker スクリプトは存在せず、Cloudflare のアセット層が全リクエストを
    // 処理する。SPA なので存在しないパスは index.html にフォールバックさせる。
    //
    // Alchemy のドキュメントは Vite プロジェクトに Website.Vite を勧めるが、
    // あちらは Alchemy の Vite プラグインをクライアントのビルドに割り込ませる
    // ため採らない — Alchemy をアプリコードに漏らさない条件(VISION)と、
    // 「wrangler は素の dist/ を配るだけ」という逃げ道の前提が崩れる。
    const client = yield* Cloudflare.Website.StaticSite('Client', {
      // Worker 名はステージから導出する。prod は kaede
      // (https://kaede.kaede-751.workers.dev)、それ以外は kaede-<stage>。
      // 固定名にするとステートが分かれていても全ステージが同じ本番 Worker を
      // 上書き・削除できてしまう。Worker 名に使えるのは英小文字・数字・
      // ハイフンのみで、既定ステージ dev_$USER は $USER 由来の任意文字
      // (ドット等)を含み得るため、使えない文字はまとめて - に潰す。
      name: stagedName(stage, 'kaede'),
      // ビルドはリポジトリルートで実行する(infra/ からの相対)。
      cwd: '..',
      command: 'pnpm --filter @kaede/client build',
      outdir: 'packages/client/dist',
      assets: {
        notFoundHandling: 'single-page-application',
      },
      // wrangler.jsonc の compatibility_date と一致させること。指定しないと
      // Alchemy は自身の既定日を使い、wrangler での手動デプロイと Alchemy の
      // 再収束が互いに互換性日付を書き換え合う(アセットのみの Worker では
      // 実害はないが、「乖離させない」という逃げ道の不変条件が最初から
      // 破れてしまう)。
      compatibility: { date: '2026-08-01' },
      // 本番のカスタムドメイン(docs/VISION.md の「名前・ドメイン」)。
      // Alchemy が DNS レコードとエッジ証明書を自動管理する。前提:
      // ①ゾーン kaede.town がアカウントに存在する(Cloudflare Registrar での
      // 取得時に自動作成される) ②CLOUDFLARE_API_TOKEN にゾーン権限がある
      // (README の「デプロイ(公開手順)」参照)。prod 以外のステージは
      // workers.dev のまま(ドメインは本番だけの概念)。workers.dev の URL も
      // 併存して同じ Worker を配信し続ける — Clerk 本番切替(ROADMAP ゲート①)
      // の移行中 URL として使う。
      ...(stage === 'prod' ? { domain: 'kaede.town' } : {}),
    });

    // 録画ファイルの置き場所(ROADMAP Phase 4 増分④→⑥): RealtimeKit の
    // クラウド録画が storage_config で直接アップロードしてくる R2 バケット。
    // 読み書きはすべて S3 API(直送・一覧・presigned DL の 3 本とも S3
    // 資格情報を要し、Worker バインディングはどれも代替できない — presign
    // 不可)。増分⑥からは module の procedure が読み手で、S3 資格情報は
    // owner が call_config 行へ播種する(packages/server/src/provider.ts /
    // README「通話/録画 API」)。録画はコミュニティの資産なので削除
    // ライフサイクルは置かず、失敗したマルチパートアップロードの破片だけ
    // 7 日で掃除する。
    // removalPolicy: retain — 録画はコミュニティの資産で再取得不能。destroy
    // (既定)だと、スタックからの削除や replace 計画の適用時に Alchemy が
    // バケットを「中身ごと空にしてから削除」する(プロバイダの emptyBucket)。
    // retain なら放棄するだけでデータは残る。誤った plan(上のアカウント解決の
    // 注意を参照)や将来のリファクタからの最終防衛線として明示する。
    yield* Cloudflare.R2.Bucket('Recordings', {
      name: stagedName(stage, 'kaede-recordings'),
      lifecycleRules: [
        {
          id: 'abort-stale-multipart-uploads',
          abortMultipartUploadsTransition: {
            condition: { type: 'Age', maxAge: 7 * 24 * 3600 },
          },
        },
      ],
    }).pipe(Alchemy.RemovalPolicy.retain());

    // アセット生成原本の置き場所(ROADMAP Phase 5 ①b⑶): グリーンバックの
    // 生成シート原本(*-original.png)は Git に入れず(1 枚 300KB〜1.3MB で
    // clone が肥大するため)、このバケットへ内容アドレス
    // (originals/<sha256>.png)で保存する。書き手は
    // scripts/upload-asset-originals.py、読み手は取り込みスクリプトの
    // 再取り込み時のみ — ランタイム(クライアント/module)からは参照しない
    // 開発時ストア。経路は Cloudflare REST API(bearer =
    // CLOUDFLARE_API_TOKEN)で S3 資格情報は使わない。オブジェクトは
    // 内容アドレスゆえ不変・単発 PUT(〜1.3MB)なので、multipart 掃除等の
    // ライフサイクルルールは置かない。
    // removalPolicy: retain — 原本は再生成にクレジット実費がかかる一点物
    // (kaede-recordings と同じ最終防衛線)。
    // 本番バケットは 2026-08-09 に API で先行作成済み(移行アップロードの
    // ため): このリコンサイラは observe→create の順で既存バケットを
    // そのまま採用するので、マージ後の CI デプロイは 409 にならず収束する。
    yield* Cloudflare.R2.Bucket('AssetOriginals', {
      name: stagedName(stage, 'kaede-asset-originals'),
    }).pipe(Alchemy.RemovalPolicy.retain());

    // 通話 API Worker `kaede-call` はここに居たが、増分⑥(ROADMAP Phase 4)で
    // 廃止した: 通話/録画 API は SpacetimeDB module の procedure に移り、
    // Cloudflare 側に残る録画関連リソースは上の R2 バケットだけ。スタックから
    // 外れた時点で Alchemy が Worker リソースを削除する(開きっぱなしの旧
    // タブは通話系操作が失敗するが、リロードで回復 — ROADMAP 増分⑥ ④)。
    // 録画バケットへのアクセスは module が S3 資格情報(owner が call_config
    // 行へ播種)で行うため、Worker バインディングは元々存在しない。

    return { url: client.url };
  }),
);
