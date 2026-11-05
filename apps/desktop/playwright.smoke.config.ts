import { defineConfig } from "@playwright/test";

// every launch spreads process.env: the app opens its windows behind the user's work, never taking focus.
// TERNO_TEST_BACKGROUND=0 brings them forward (watching a run).
process.env.TERNO_TEST_BACKGROUND ??= "1";

// Each file has its own copy of the app and its own profile, and its servers listen on port 0, so files run side by side;
// a file's own tests stay in order on one worker. update.smoke first: it's the longest and serial, so it sets the floor.
export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  timeout: 120_000,
  workers: 3,
  reporter: [["list"]],
  outputDir: "../../test-results/desktop-smoke",
  projects: [
    { name: "update", testMatch: "**/update.smoke.ts" },
    { name: "packaged", testMatch: "**/*.smoke.ts", testIgnore: "**/update.smoke.ts" },
  ],
});
