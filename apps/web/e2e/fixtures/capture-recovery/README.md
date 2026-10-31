# On-demand capture repair qualification

Dev-only native browser BackendCore/IndexedDB/nested incoming worker with synthetic managed Gmail. No production build or live Google/GIS access. Not a normal Playwright spec or entrypoint.

From the checkout root, with the standard loopback network guard appended to inherited NODE_OPTIONS:

1. Start `pnpm --filter @terno/web exec vite --config e2e/fixtures/capture-recovery/vite.config.mts` on reserved61810.
2. Run `node apps/web/e2e/fixtures/capture-recovery/qualify.mjs` (also guarded). Create `/tmp/terno-w10-repair` first. It opens an isolated ephemeral Chromium context, checks healthy-state discovery and reload/reopen, keyboard retry and retained focus, axe in light/dark, and writes both captures there.
3. Stop and join only the owned dev server PID. No production UI route exposes the synthetic fixture.

The worker accepts only its explicit synthetic native Requests; unlisted routes fail. Page network is loopback-only. Temp browser context/storage and workers are closed by the script. Existing pending/blocked debt survives reload through native IndexedDB. Captures qualify this component, not a full-app or release suite.
