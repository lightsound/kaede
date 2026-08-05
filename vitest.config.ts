import { defineConfig } from 'vitest/config';

/**
 * One run across every package, so a single Istanbul report covers the whole
 * repo. `fallow health` reads that report (see .fallowrc.jsonc `health.coverage`)
 * to compute real CRAP scores instead of estimating coverage from the module
 * graph, which otherwise flags well-tested functions as risky.
 */
export default defineConfig({
  test: {
    projects: ['packages/shared', 'packages/client', 'packages/worker'],
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
