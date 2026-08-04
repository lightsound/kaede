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
// spawn しようとする(alchemy 2.0.0-beta.67 の bin/cli.js)。環境変数の
// 設定は Windows の cmd.exe でも動くよう cross-env 経由にしている。
import * as Alchemy from 'alchemy';
import * as Cloudflare from 'alchemy/Cloudflare';
import * as Effect from 'effect/Effect';

// アカウント「Kaede」の ID(シークレットではない公開識別子)。API トークンと
// 違い環境変数で配る必要がないため、ここに固定して deploy コマンドの前提を
// 減らす。別アカウントに向けたいときは環境変数が優先される。
process.env.CLOUDFLARE_ACCOUNT_ID ??= '751c8a59858c9c04a8e722df7330444d';

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
      name: stage === 'prod' ? 'kaede' : `kaede-${workerNameSlug(stage)}`,
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

    return { url: client.url };
  }),
);
