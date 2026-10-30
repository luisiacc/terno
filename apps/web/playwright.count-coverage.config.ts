import { defineConfig } from "@playwright/test";
const port = Number(process.env.E2E_PORT ?? 55320);
export default defineConfig({
  testDir: "e2e", testMatch: "count-coverage.dev.ts", workers: 1, retries: 0, timeout: 45_000,
  expect: { timeout: 8_000 }, outputDir: "/tmp/terno-a13/results", reporter: "list",
  use: { baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" },
  webServer: { command: `VITE_TARGET=desktop pnpm vite --mode development --port ${port} --strictPort --host 127.0.0.1`, url: `http://127.0.0.1:${port}`, reuseExistingServer: false, timeout: 45_000 },
});
