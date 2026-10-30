import { defineConfig } from "@playwright/test";

const port = Number(process.env.WEB_PORT ?? 55760);
// Deliberately excluded from the production Web projects' *.web.spec.ts discovery.
export default defineConfig({
  testDir: "e2e-web/w12-lost-ack", testMatch: "*.dev.spec.ts", workers: 1, retries: 0, timeout: 90_000,
  outputDir: `/tmp/terno-w12-lost-ack-${port}/results`, reporter: "list",
  use: { baseURL: `http://127.0.0.1:${port}`, viewport: { width: 800, height: 650 }, bypassCSP: true, serviceWorkers: "block", reducedMotion: "reduce", trace: "retain-on-failure" },
  webServer: { command: `VITE_TARGET=web VITE_WEB_DEMO=1 pnpm vite --host 127.0.0.1 --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: false, timeout: 45_000 },
});
