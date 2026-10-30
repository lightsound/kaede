import { defineConfig } from 'vite-plus';

/**
 * Vite+ のワークスペースルート設定。lint（Oxlint）/ fmt（Oxfmt）/ test
 * （同梱 Vitest）の既定をここに集約する（旧 biome.json + vitest.config.mts
 * の後継）。パッケージ側の vite.config.ts はビルドとテストのプロジェクト
 * 設定だけを持つ。
 *
 * 除外パスは旧 biome.json の files.includes の否定分を引き継いだもの:
 * 生成物（module_bindings、Alchemy ステート）、ロックファイル、外部由来の
 * skills、整形対象外のドキュメントとワークフロー。
 */
const ignorePatterns = [
  '**/module_bindings/**',
  'infra/.alchemy/**',
  'bun.lock',
  '**/skills/sp-*/**',
  '**/skills/stripe-projects-cli/**',
  '.github/workflows/pullfrog.yml',
  'docs/factory-yield.md',
];

export default defineConfig({
  fmt: {
    // 旧 Biome formatter の設定（2スペース、行幅100、シングルクォート）を引き継ぐ。
    singleQuote: true,
    printWidth: 100,
    sortPackageJson: false,
    ignorePatterns,
  },
  lint: {
    plugins: ['typescript', 'react', 'import', 'vitest', 'jsx-a11y'],
    // 旧 Biome recommended preset のカバー範囲（correctness + suspicious）に
    // 寄せ、重大度は error を既定にする（警告ゼロ運用: CI は
    // --deny-warnings で警告でも落ちる）。perf / style / pedantic は
    // Biome recommended に相当分がなく、移行直後のノイズ（意図的な直列
    // await、アンダースコア接頭辞など）しか出なかったため切る。
    categories: {
      correctness: 'error',
      suspicious: 'error',
      perf: 'off',
      style: 'off',
      pedantic: 'off',
      restriction: 'off',
      nursery: 'off',
    },
    options: {
      typeAware: true,
      typeCheck: true,
    },
    rules: {
      // plugin-react は classic runtime 前提のルール。tsconfig は
      // jsx: react-jsx（automatic runtime）で React の import は不要。
      'react/react-in-jsx-scope': 'off',
      // このコードベースに this を使うクラスはなく、メソッド参照は
      // SpacetimeDB 生成バインディングと this を持たない関数オブジェクト
      // （props / hooks）だけ。typescript-eslint 由来のこのルールは
      // Biome に相当分がない。
      'typescript/unbound-method': 'off',
      // 外部データ（アセットの glob マップ、SDK ペイロード）の assertion は
      // 近傍の実行時チェックと対になっている。Biome に相当分がない。
      'typescript/no-unsafe-type-assertion': 'off',
      // __kaedeE2E*（e2e フック）と __KAEDE_*（ビルド時定数）は
      // パッケージをまたぐ命名契約そのもの。
      'eslint/no-underscore-dangle': 'off',
      // e2e のブラウザ操作と負荷ツールのボット生成は直列実行が意図。
      'eslint/no-await-in-loop': 'off',
      // posthog-js の正規の使い方（default import）。同名の named export が
      // 型側にあるための誤検知。
      'import/no-named-as-default': 'off',
      // 散文コメント中の "it (" をコメントアウトされたテストと誤認する。
      'vitest/no-commented-out-tests': 'off',
      // ファクトリ／インターフェースのパターンで、外側のパラメータと
      // 同じ意味（現在時刻など）を持つ引数が同名になるのは意図的。
      // Biome recommended に相当分がない。
      'eslint/no-shadow': 'off',
      // useEffect のクリーンアップは「掃除関数か無し」を返すのが定型で、
      // 混在は意図的。Biome recommended に相当分がない。
      'typescript/consistent-return': 'off',
    },
    overrides: [
      {
        // テストのフェイクは構造的なスタブで、呼び出しはフェイク自身の
        // surface 経由で検証する。モックへの型引数強制（typescript-eslint
        // 由来）は Biome に相当分がない。
        files: ['packages/*/test/**/*.ts', 'packages/*/test/**/*.tsx'],
        rules: {
          'vitest/require-mock-type-parameters': 'off',
        },
      },
    ],
    ignorePatterns,
  },
  test: {
    projects: ['packages/shared', 'packages/client'],
    coverage: {
      provider: 'v8',
      reporter: ['json', 'text-summary'],
      reportsDirectory: 'coverage',
      // Only shipped code: tests scoring themselves says nothing about risk.
      include: ['packages/*/src/**/*.{ts,tsx}'],
      exclude: ['**/module_bindings/**'],
    },
  },
});
