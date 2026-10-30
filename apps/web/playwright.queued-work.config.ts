import { defineConfig } from "@playwright/test";

const port = Number(process.env.WEB_PORT ?? 55530);
export default defineConfig({
  testDir: "e2e-web/queued-work", testMatch: "*.dev.spec.ts", workers: 1, timeout: 120_000,
  outputDir: "/tmp/terno-w11-queued-work-results", reporter: "list",
  use: { baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1440, height: 900 }, bypassCSP: true, serviceWorkers: "block", reducedMotion: "reduce" },
  webServer: { command: `VITE_TARGET=web VITE_WEB_DEMO=1 pnpm vite --config vite.queued-work.config.ts --host 127.0.0.1 --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: false, timeout: 45_000 },
});
