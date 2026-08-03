import { fileURLToPath } from 'node:url';
import posthogRollupPlugin from '@posthog/rollup-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type PluginOption } from 'vite';

/**
 * リポジトリルート(Stripe Projects 管理の .env が置かれている場所)。
 * URL.pathname は Windows で `/C:/...` になり Node の fs が拒むため
 * fileURLToPath で変換する。
 */
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * PostHog の認証情報の読み口 — .env の手編集・リネームはしない(Stripe
 * Projects 管理)。優先順: プロセス環境変数(CI のデプロイジョブが渡す) >
 * packages/client/.env* > ルート .env(`stripe projects env --pull` の
 * 書き出し先)。prefix '' は VITE_ 以外も読むためで、これらの値が
 * クライアントへ渡るのは define で明示した定数だけ(import.meta.env への
 * 自動露出はされない)。
 */
function envReader(mode: string): (name: string) => string | undefined {
  const clientEnv = loadEnv(mode, import.meta.dirname, '');
  const rootEnv = loadEnv(mode, REPO_ROOT, '');
  return (name) => process.env[name] ?? clientEnv[name] ?? rootEnv[name];
}

/**
 * エラー監視の初期化ゲート(ADR §8.2、ROADMAP Phase 2): 実キーが入るのは
 * 本番ビルド(`vite build` = mode 'production')だけ。「キーの有無」での
 * 判定は不可 — ローカル .env に実キーが常在するため、それでは `pnpm dev`
 * のノイズが本番プロジェクト(Free 枠は 1 プロジェクト)を汚染する。
 * 動作確認は明示オプトインのローカル本番ビルド(pnpm --filter
 * @maple/client build && vite preview)で行う。
 */
function posthogKey(mode: string, readEnv: (name: string) => string | undefined): string {
  if (mode !== 'production') return '';
  return readEnv('POSTHOG_ANALYTICS_API_KEY') ?? '';
}

/**
 * ソースマップのアップロード(ADR §8.4)は main マージ後のデプロイジョブ
 * 限定(PR ビルドが symbol sets を汚さないため)。ゲートは process.env
 * のみ — ルート .env には POSTHOG_ANALYTICS_PERSONAL_API_KEY が常在する
 * ため、loadEnv 経由で読むとローカルビルドが毎回アップロードを試みて
 * しまう。デプロイジョブだけが POSTHOG_API_KEY / POSTHOG_PROJECT_ID を
 * 渡す(ci.yml)。アップロード失敗はビルドごと失敗する(実測 2026-08-03)
 * ので、スコープ不足のキーを渡してはならない。
 */
function sourcemapUploadPlugins(host: string): PluginOption[] {
  const personalApiKey = process.env.POSTHOG_API_KEY;
  const projectId = process.env.POSTHOG_PROJECT_ID;
  if (!personalApiKey || !projectId) return [];
  return [
    posthogRollupPlugin({
      personalApiKey,
      projectId,
      host,
      // 公開せずアップロードのみ: build.sourcemap 'hidden' と併用し、
      // アップロード後に .map を dist から消す。
      sourcemaps: { deleteAfterUpload: true },
    }) as PluginOption,
  ];
}

export default defineConfig(({ mode }) => {
  const readEnv = envReader(mode);
  const posthogHost = readEnv('POSTHOG_ANALYTICS_HOST') ?? 'https://us.posthog.com';
  return {
    // Absolute asset paths (the Vite default). Cloudflare Workers serves the
    // build from the domain root with an index.html SPA fallback, so a deep
    // URL like /some/route must still resolve assets at /assets/* — a relative
    // base would make it request /some/assets/* and receive the fallback HTML.
    // (The old `base: './'` existed for GitHub Pages subpath serving, which is
    // no longer a deploy target.)
    plugins: [react(), ...sourcemapUploadPlugins(posthogHost)],
    define: {
      __KAEDE_POSTHOG_KEY__: JSON.stringify(posthogKey(mode, readEnv)),
      __KAEDE_POSTHOG_HOST__: JSON.stringify(posthogHost),
    },
    build: {
      // 'hidden': .map は生成するが JS に参照コメントを書かない。スタック
      // トレース解決はアップロードされた symbol sets が担い、ブラウザには
      // 何も公開しない。
      sourcemap: 'hidden',
    },
  };
});
