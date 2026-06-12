import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset paths so the build works when served from a GitHub Pages
  // project subpath (e.g. /<repo>/) as well as from the domain root.
  base: './',
  plugins: [react()],
});
