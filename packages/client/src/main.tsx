// fallow-ignore-file coverage-gaps -- the browser entry point: it only mounts App into the DOM, so there is nothing to import from a test
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ClerkGate } from './auth.package';
import { initTelemetry } from './telemetry.package';

// Before anything renders, so exceptions thrown during mount are captured
// too. A no-op in builds without a key (dev, PR CI) — see vite.config.ts.
initTelemetry();

const root = document.getElementById('root');
if (!root) throw new Error('#root element is missing from index.html');

// The dev-only asset studio (Phase 5 ①b⑷ — the read-only inspection
// viewer): /assets renders it instead of the world. The same DEV gate as
// the ?outfit dress-up preview, so production bundles drop the studio —
// and the asset enumeration behind it — entirely.
if (import.meta.env.DEV && window.location.pathname === '/assets') {
  void import('./studio.package').then(({ AssetStudio }) => {
    createRoot(root).render(
      <StrictMode>
        <AssetStudio />
      </StrictMode>,
    );
  });
} else {
  createRoot(root).render(
    <StrictMode>
      <ClerkGate>
        <App />
      </ClerkGate>
    </StrictMode>,
  );
}
