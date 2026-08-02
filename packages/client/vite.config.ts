import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  // Absolute asset paths (the Vite default). Cloudflare Workers serves the
  // build from the domain root with an index.html SPA fallback, so a deep
  // URL like /some/route must still resolve assets at /assets/* — a relative
  // base would make it request /some/assets/* and receive the fallback HTML.
  // (The old `base: './'` existed for GitHub Pages subpath serving, which is
  // no longer a deploy target.)
  plugins: [react()],
});
