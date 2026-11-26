import { defineConfig } from "@playwright/test";

// Plan 283: the debugging probe (e2e/debugging.smoke.ts) against a SHIPPED build, which Playwright can't attach to, so it
// drives the app's binary directly. The release jobs run it on what they built (.github/workflows/release.yml); locally,
// after packaging with TERNO_SHIPPED=1. Launches stay behind the user's work.
process.env.TERNO_TEST_BACKGROUND ??= "1";
process.env.TERNO_SMOKE_SHIPPED = "1";

export default defineConfig({
  testDir: "e2e",
  testMatch: "**/debugging.smoke.ts",
  timeout: 120_000,
  workers: 1,
  reporter: [["list"]],
  outputDir: "../../test-results/desktop-shipped",
});
