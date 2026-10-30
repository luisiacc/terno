import { defineConfig } from "@playwright/test";

const port = Number(process.env.E2E_PORT ?? 54740);

export default defineConfig({
  testDir: "e2e",
  testMatch: ["empty-list.spec.ts", "list-focus.spec.ts", "list-keyboard-entry.spec.ts"],
  globalSetup: "./e2e/search-coverage.setup.ts",
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  outputDir: "../../test-results/empty-list",
  reporter: "list",
  use: { baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1440, height: 900 }, locale: "en-US", reducedMotion: "reduce", trace: "retain-on-failure" },
  webServer: {
    command: `VITE_TARGET=desktop VITE_RENDER_PROBE=1 pnpm vite --mode development --port ${port} --strictPort --host 127.0.0.1`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 45_000,
  },
});
