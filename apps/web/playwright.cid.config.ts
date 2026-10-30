import { defineConfig, devices } from "@playwright/test";

/** Standalone CID fixture: no application build, backend, or global setup. */
export default defineConfig({
  testDir: "e2e",
  testMatch: "cid-render.spec.ts",
  workers: 1,
  retries: 0,
  timeout: 45_000,
  outputDir: process.env.CID_TEST_OUTPUT_DIR ?? "../../test-results/cid",
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    locale: "en-US",
    timezoneId: "America/Mexico_City",
    colorScheme: "light",
    reducedMotion: "reduce",
    trace: "retain-on-failure",
    serviceWorkers: "block",
  },
});
