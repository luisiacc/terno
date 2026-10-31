import { defineConfig, devices } from "@playwright/test";
const port = Number(process.env.WEB_PORT ?? 61320);
export default defineConfig({
  testDir: "e2e-web", testMatch: "mime-retention.dev.spec.ts", workers: 1, retries: 0,
  timeout: 45_000, outputDir: "/tmp/terno-w11-s48/browser-results", reporter: [["list"]],
  use: { ...devices["Desktop Chrome"], baseURL: `http://127.0.0.1:${port}`, serviceWorkers: "block", trace: "retain-on-failure" },
  webServer: {
    command: `pnpm vite --config e2e-web/mime-retention/vite.config.ts --port ${port} --strictPort --host 127.0.0.1`,
    url: `http://127.0.0.1:${port}/e2e-web/mime-retention/index.html`, reuseExistingServer: false, timeout: 60_000,
  },
});
