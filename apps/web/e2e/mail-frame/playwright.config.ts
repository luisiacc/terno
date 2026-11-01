import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "*.probe.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  outputDir: "/tmp/terno-w11-tall-mail-61630/results",
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:61630", viewport: { width: 1000, height: 800 }, reducedMotion: "reduce" },
});
