import { defineConfig } from "@playwright/test";

const port = Number(process.env.WEB_PORT ?? 61420);
export default defineConfig({
  testDir: "e2e-web/b41-onboarding", testMatch: "*.dev.spec.ts", workers: 1, retries: 0, timeout: 90_000,
  outputDir: "/tmp/terno-w05-b41/production/browser-results", reporter: "list",
  use: { baseURL: `http://127.0.0.1:${port}`, viewport: { width: 900, height: 740 }, bypassCSP: true, serviceWorkers: "block", reducedMotion: "reduce", trace: "retain-on-failure" },
  webServer: { command: `VITE_TARGET=web VITE_WEB_DEMO=1 pnpm vite --host 127.0.0.1 --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: false, timeout: 45_000 },
});
