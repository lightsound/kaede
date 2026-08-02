// fallow-ignore-file unused-file -- alchemy CLI が直接実行する IaC エントリポイント。アプリのモジュールグラフからは到達しない
// kaede の Cloudflare リソース定義(Alchemy v2)。
//
// このディレクトリの外に Alchemy / Effect を漏らさないこと(docs/VISION.md の
// IaC 行のベータ採用条件)。アプリコードはこのファイルの存在を知らない。
//
// 実行は infra/ を作業ディレクトリとして `alchemy deploy --stage prod` で行う
// (`pnpm --filter @maple/infra deploy:prod`。素の `deploy` は pnpm の
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
    const client = yield* Cloudflare.Website.StaticSite('Client', {
      // Worker 名はステージから導出する。prod は kaede
      // (https://kaede.kaede-751.workers.dev)、それ以外は kaede-<stage>。
      // 固定名にするとステートが分かれていても全ステージが同じ本番 Worker を
      // 上書き・削除できてしまう(Worker 名の文字種に合わせ _ は - に変換)。
      name: stage === 'prod' ? 'kaede' : `kaede-${stage.toLowerCase().replace(/_/g, '-')}`,
      // ビルドはリポジトリルートで実行する(infra/ からの相対)。
      cwd: '..',
      command: 'pnpm --filter @maple/client build',
      outdir: 'packages/client/dist',
      assets: {
        notFoundHandling: 'single-page-application',
      },
    });

    return { url: client.url };
  }),
);
