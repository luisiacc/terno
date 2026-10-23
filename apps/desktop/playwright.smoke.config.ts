import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.smoke.ts",
  timeout: 120_000,
  workers: 1,
  reporter: [["list"]],
  outputDir: "../../test-results/desktop-smoke",
});
