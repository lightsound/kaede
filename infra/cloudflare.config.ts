// fallow-ignore-file unused-file -- cf deploy reads this config entrypoint directly; the app module graph never reaches it
// Manual-deploy escape hatch for `cf deploy`, used when Alchemy cannot be
// (beta bugs etc.). Deploys the same Worker (kaede) with the same assets
// layout as alchemy.run.ts — do not let them drift apart. The procedure is
// in README「デプロイ(公開手順)」.
import { defineConfig } from 'cf/config';

export default defineConfig({
  // Public identifier, not a secret (same rationale as alchemy.run.ts).
  accountId: '751c8a59858c9c04a8e722df7330444d',
  worker: {
    name: 'kaede',
    // Must match `compatibility.date` in alchemy.run.ts. Without a pin on
    // both sides, a cf manual deploy and an Alchemy re-convergence would
    // keep rewriting each other's compatibility date.
    compatibilityDate: '2026-08-01',
    // Paired with `domain: 'kaede.town'` in alchemy.run.ts (prod only).
    domains: ['kaede.town'],
    // Declaring a domain would otherwise imply *.workers.dev should stop
    // serving, so keep this explicit. The workers.dev URL intentionally
    // coexists as the migration URL for the Clerk production cutover (see
    // the domain comment in alchemy.run.ts), matching Alchemy's default
    // (WorkersDevConfig.enabled: true).
    workersDev: true,
    assets: {
      // The directory itself is declared in wrangler.config.ts
      // (assetsDirectory): `cf deploy` delegates the build to wrangler,
      // which reads that shim.
      notFoundHandling: 'single-page-application',
    },
  },
});
