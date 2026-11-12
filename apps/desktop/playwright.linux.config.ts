import { defineConfig } from "@playwright/test";

// Plan 189: the installed Linux package (e2e/linux.smoke.ts). Run under a display and a session bus with an unlocked
// keyring: .github/workflows/release.yml, or docs/DEVELOPMENT.md → Linux for Docker.
export default defineConfig({
  testDir: "e2e",
  testMatch: "**/linux.smoke.ts",
  timeout: 120_000,
  workers: 1,
  reporter: [["list"]],
  outputDir: "../../test-results/desktop-linux-smoke",
});
