// fallow-ignore-file unused-file -- cf deploy delegates the build to wrangler, which reads this shim directly; the app module graph never reaches it
// Wrangler-side half of the cf config pair. `cf deploy` delegates the build
// to the installed wrangler package (the "wrangler" bundler selected by
// `cf migrate`), which reads this shim; keep the wrangler devDependency.
// It holds the wrangler-only settings cloudflare.config.ts does not cover:
// the assets directory the Build Output is produced from, and typegen.
import { defineWranglerConfig } from 'wrangler/experimental-config';

export default defineWranglerConfig({
  types: {
    generate: false,
  },
  assetsDirectory: '../packages/client/dist',
});
