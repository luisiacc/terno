import { defineConfig, devices } from "@playwright/test";

/**
 * The web build (VITE_TARGET=web): the backend in a dedicated worker on
 * SQLite-WASM over OPFS, served as a static site. Separate from
 * playwright.config.ts so the desktop e2e run never builds it.
 *
 * - web: lifecycle (Web Locks, takeover, open errors), offline, gating, flows
 * - web-perf: budgets at 10k and 50k messages (persistent profile, real OPFS)
 */
const WEB = 5181;

export default defineConfig({
  testDir: "e2e-web",
  fullyParallel: true,
  workers: process.env.CI ? 2 : 3,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  outputDir: "../../test-results/e2e-web",
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${WEB}`,
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 900 },
    locale: "es-MX",
    timezoneId: "America/Mexico_City",
    colorScheme: "light",
    reducedMotion: "reduce",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "web", testMatch: /web\.spec\.ts/ },
    // alone: timings must not compete with parallel workers
    { name: "web-perf", testMatch: /web-perf\.spec\.ts/, fullyParallel: false, workers: 1, timeout: 1_800_000 },
  ],
  webServer: [
    {
      // a demo build (seeds an empty mailbox from the mock generator; ?demo=<threads>, ?mailbox=<name>)
      command: `VITE_TARGET=web VITE_WEB_DEMO=1 pnpm vite build --outDir dist-web-e2e && pnpm vite preview --outDir dist-web-e2e --port ${WEB} --strictPort --host 127.0.0.1`,
      url: `http://127.0.0.1:${WEB}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
