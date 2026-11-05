import { defineConfig } from "@playwright/test";

process.env.TERNO_TEST_BACKGROUND ??= "1";

/** The packaged app's start time, alone on the machine: see e2e/startup.perf.ts. */
export default defineConfig({
  testDir: "e2e",
  testMatch: "startup.perf.ts",
  timeout: 120_000,
  workers: 1,
  reporter: [["list"]],
  outputDir: "../../test-results/desktop-startup",
});
