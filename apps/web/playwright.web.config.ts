import { defineConfig, devices } from "@playwright/test";

/**
 * The web build (VITE_TARGET=web): the backend in a dedicated worker on
 * SQLite-WASM over OPFS, served as a static site. Separate from
 * playwright.config.ts so the desktop e2e run never builds it.
 *
 * - web: lifecycle (Web Locks, takeover, open errors), offline, gating, flows
 * - web-conformance: the MailStore and engine suites inside a Chromium worker
 * - web-perf: budgets at 10k and 50k messages (persistent profile, real OPFS)
 */
// WEB_PORT lets a second checkout run this suite alongside (the conformance server takes the next port)
const WEB = Number(process.env.WEB_PORT ?? 5181);
const CONFORMANCE = WEB + 1;
const OUT = process.env.WEB_PORT ? `dist-web-e2e-${WEB}` : "dist-web-e2e";

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
    locale: "en-US",
    timezoneId: "America/Mexico_City",
    colorScheme: "light",
    reducedMotion: "reduce",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "web", testMatch: /(web|updates)\.spec\.ts/ },
    { name: "web-conformance", testMatch: /conformance\.spec\.ts/, use: { baseURL: `http://127.0.0.1:${CONFORMANCE}` } },
    // alone: timings must not compete with parallel workers
    { name: "web-perf", testMatch: /web-perf\.spec\.ts/, fullyParallel: false, workers: 1, timeout: 1_800_000 },
  ],
  webServer: [
    {
      // a demo build (seeds an empty mailbox from the mock generator; ?demo=<threads>, ?mailbox=<name>)
      command: `VITE_TARGET=web VITE_WEB_DEMO=1 pnpm vite build --outDir ${OUT} && pnpm vite preview --outDir ${OUT} --port ${WEB} --strictPort --host 127.0.0.1`,
      url: `http://127.0.0.1:${WEB}`,
      // never reuse: the command builds this checkout, a running server may be serving an older build
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `pnpm vite build -c e2e-web/conformance/vite.config.ts && pnpm vite preview -c e2e-web/conformance/vite.config.ts --port ${CONFORMANCE} --strictPort --host 127.0.0.1`,
      url: `http://127.0.0.1:${CONFORMANCE}`,
      // never reuse: the command builds this checkout, a running server may be serving an older build
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
