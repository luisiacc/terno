import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const outputDir = process.env.TRANSPORT_RESULTS ?? "/tmp/terno-w12-transport/results";
const port = Number(process.env.E2E_PORT ?? 55120);

export default defineConfig({
  testDir: "e2e",
  testMatch: "composer-transport-recovery.dev.ts",
  globalSetup: "./e2e/global-setup.ts",
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  outputDir,
  reporter: [["list"], ["json", { outputFile: join(outputDir, "report.json") }]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1440, height: 900 },
    locale: "en-US",
    timezoneId: "America/Costa_Rica",
    reducedMotion: "reduce",
    trace: "retain-on-failure",
  },
  webServer: {
    command: `VITE_TARGET=desktop VITE_RENDER_PROBE=1 pnpm --config.verify-deps-before-run=false vite --mode development --port ${port} --strictPort --host 127.0.0.1`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
