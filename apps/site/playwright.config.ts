import { defineConfig, devices } from "@playwright/test";

// plan 97: the built site under `wrangler dev` (the real Worker, local D1 with the migrations applied).
// SITE_PORT lets two checkouts run side by side.
const PORT = Number(process.env.SITE_PORT ?? 8797);

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  workers: 4,
  timeout: 30_000,
  outputDir: "../../test-results/site",
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${PORT}`, ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
  webServer: {
    command: `pnpm build && rm -rf .wrangler/state-e2e && wrangler d1 migrations apply DB --local --persist-to .wrangler/state-e2e && wrangler dev --port ${PORT} --ip 127.0.0.1 --persist-to .wrangler/state-e2e`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
