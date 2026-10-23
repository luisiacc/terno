import { defineConfig, devices } from "@playwright/test";

/**
 * E2E + visual + UI-perf suites. The renderer is served as a PRODUCTION build
 * (vite preview) so perf numbers reflect what ships (React Compiler, prod React);
 * every test talks to a real backend over WebSocket (see e2e/fixtures.ts).
 */
const PORT = 5180;

export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  retries: 0,
  timeout: 45_000,
  expect: {
    timeout: 8_000,
    toHaveScreenshot: { maxDiffPixelRatio: 0.002, animations: "disabled", caret: "hide", scale: "device" },
  },
  outputDir: "../../test-results/e2e",
  snapshotPathTemplate: "{testDir}/__screenshots__/{testFilePath}/{arg}{ext}",
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    locale: "es-MX",
    timezoneId: "America/Mexico_City",
    colorScheme: "light",
    reducedMotion: "reduce",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "e2e", testIgnore: /perf\.spec\.ts/ },
    // perf runs alone (no CPU contention from parallel workers)
    { name: "perf", testMatch: /perf\.spec\.ts/, dependencies: ["e2e"], fullyParallel: false, workers: 1, use: { deviceScaleFactor: 1 } },
  ],
  webServer: {
    command: `pnpm vite build && pnpm vite preview --port ${PORT} --strictPort --host 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
