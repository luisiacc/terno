import { defineConfig } from "@playwright/test";

const port = Number(process.env.E2E_PORT ?? 54660);

/** S58: scoped renderer checks on Vite dev, without a production webServer build. */
export default defineConfig<{ design: "lumen" }>({
  testDir: "e2e",
  projects: [
    { name: "coverage", testMatch: "search-coverage.spec.ts" },
    { name: "existing-search", testMatch: ["search.spec.ts", "search-everywhere.spec.ts"], use: { design: "lumen" } },
  ],
  globalSetup: "./e2e/search-coverage.setup.ts",
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  outputDir: "../../test-results/search-coverage",
  reporter: "list",
  use: { baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1440, height: 900 }, locale: "en-US", reducedMotion: "reduce", trace: "retain-on-failure" },
  webServer: {
    command: `VITE_TARGET=desktop pnpm vite --mode development --port ${port} --strictPort --host 127.0.0.1`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 45_000,
  },
});
