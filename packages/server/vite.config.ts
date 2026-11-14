import { spacetimedbModuleTestPlugin } from 'spacetimedb/server/test-utils/vitest';
import { defineConfig } from 'vite-plus';

// Test-project config only: the server package has no client build (its
// build is `spacetime build`). The SpacetimeDB module-test plugin makes
// the module importable under vitest (the real `spacetimedb/server`
// entry loads the host-only `spacetime:sys` module) and backs the
// official test harness with its portable in-process datastore.
export default defineConfig({
  plugins: [spacetimedbModuleTestPlugin()],
  test: {
    include: ['test/**/*.test.ts'],
  },
});
