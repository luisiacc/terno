import { defineConfig, devices } from "@playwright/test";
const port = Number(process.env.E2E_PORT ?? 56020);
export default defineConfig({
  testDir: "e2e", testMatch: "w09-signature.dev.ts", globalSetup: "./e2e/reply-identity.setup.ts",
  workers: 1, retries: 0, timeout: 60_000, expect: { timeout: 8_000 },
  outputDir: `/tmp/terno-w09-signature-${port}/results`, reporter: "list",
  use: { ...devices["Desktop Chrome"], baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1440, height: 900 }, reducedMotion: "reduce", serviceWorkers: "block", trace: "retain-on-failure" },
  webServer: { command: `VITE_TARGET=desktop VITE_RENDER_PROBE=1 pnpm vite --mode development --port ${port} --strictPort --host 127.0.0.1`, url: `http://127.0.0.1:${port}`, reuseExistingServer: false, timeout: 30_000 },
});
