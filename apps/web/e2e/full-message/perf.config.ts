import { defineConfig, devices } from "@playwright/test";

/** Only the two original HtmlBody hot-path cases, unchanged, on the authorized dev server. */
export default defineConfig({
  testDir: "..",
  testMatch: "perf.spec.ts",
  grep: /a long conversation: expanding 19 messages|resizing panes \(plan 21\):/,
  globalSetup: "./perf-setup.ts",
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  outputDir: "/tmp/terno-w11-full-61640/perf-results",
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:61640", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1,
    locale: "en-US", timezoneId: "America/Mexico_City", colorScheme: "light", reducedMotion: "reduce", trace: "off",
    // All non-loopback browser requests fail at an owned bound, non-listening local proxy; provider/image traffic cannot leave this host.
    proxy: { server: "http://127.0.0.1:61641", bypass: "127.0.0.1,localhost" },
  },
});
