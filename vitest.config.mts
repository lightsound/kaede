import { defineConfig } from 'vitest/config';

/**
 * `.mts` so Vite's native config loader (the planned default) treats this
 * file as ESM. The repo root package.json has no `"type": "module"`, and a
 * `.ts` config is loaded as CommonJS — Vite 8.3 already warns about that.
 *
 * One run across every package, so a single Istanbul report covers the whole
 * repo. `fallow health` reads that report (see .fallowrc.jsonc `health.coverage`)
 * to compute real CRAP scores instead of estimating coverage from the module
 * graph, which otherwise flags well-tested functions as risky.
 */
export default defineConfig({
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
