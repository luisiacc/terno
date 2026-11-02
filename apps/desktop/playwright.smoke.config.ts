import { defineConfig } from "@playwright/test";

// every launch spreads process.env: the app opens its windows behind the user's work, never taking focus.
// TERNO_TEST_BACKGROUND=0 brings them forward (watching a run).
process.env.TERNO_TEST_BACKGROUND ??= "1";

export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.smoke.ts",
  timeout: 120_000,
  workers: 1,
  reporter: [["list"]],
  outputDir: "../../test-results/desktop-smoke",
});
