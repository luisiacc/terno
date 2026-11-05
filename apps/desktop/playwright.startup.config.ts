import { defineConfig } from "@playwright/test";

process.env.TERNO_TEST_BACKGROUND ??= "1";

/** What the packaged app has to do in a given time, alone on the machine (tagged @alone): see e2e/startup.perf.ts. */
export default defineConfig({
  testDir: "e2e",
  testMatch: ["startup.perf.ts", "mailbox.smoke.ts"],
  grep: /@alone/,
  timeout: 120_000,
  workers: 1,
  reporter: [["list"]],
  outputDir: "../../test-results/desktop-startup",
});
