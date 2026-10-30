import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.WEB_PORT ?? 56750);
export default defineConfig({
  testDir: "e2e-web",
  testMatch: "storage-send.web.spec.ts",
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  outputDir: "/tmp/terno-release-web-send/results",
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
    trace: "retain-on-failure",
    serviceWorkers: "block",
  },
  webServer: {
    command: `NODE_ENV=production VITE_TARGET=web VITE_WEB_DEMO=1 pnpm --config.verify-deps-before-run=false vite --mode development --port ${port} --strictPort --host 127.0.0.1`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
