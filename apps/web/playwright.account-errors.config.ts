import { defineConfig } from "@playwright/test";

const port = Number(process.env.E2E_PORT ?? 55040);

export default defineConfig({
  testDir: "e2e",
  testMatch: ["account-errors.spec.ts", "settings.spec.ts", "resign-in.spec.ts"],
  globalSetup: "./e2e/account-errors.setup.ts",
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  outputDir: "../../test-results/account-errors",
  reporter: "list",
  use: { baseURL: `http://127.0.0.1:${port}`, locale: "en-US", reducedMotion: "reduce", trace: "retain-on-failure" },
  webServer: {
    command: `VITE_TARGET=desktop pnpm vite --mode development --port ${port} --strictPort --host 127.0.0.1`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 45_000,
  },
});
