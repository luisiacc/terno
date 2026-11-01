import { defineConfig, devices } from "@playwright/test";
const port = Number(process.env.E2E_PORT ?? 61830);
export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  projects: [{ name: "e2e", testMatch: ["recipient-recovery.spec.ts", "recipient-warning-clear.dev.ts"] }],
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  outputDir: "/tmp/terno-w01-snack/r4/results",
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    locale: "en-US",
    timezoneId: "America/Mexico_City",
    colorScheme: "light",
    reducedMotion: "reduce",
    trace: "retain-on-failure",
  },
  webServer: {
    command: `VITE_RENDER_PROBE=1 pnpm --config.verify-deps-before-run=false vite --port ${port} --strictPort --host 127.0.0.1`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
