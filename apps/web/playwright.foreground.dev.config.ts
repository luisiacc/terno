import { defineConfig } from "@playwright/test";
const port = Number(process.env.WEB_PORT ?? 61910);
export default defineConfig({
  testDir: "e2e", testMatch: "foreground-reader.dev.ts", workers: 1, retries: 0, timeout: 45_000,
  outputDir: "/tmp/terno-w05-foreground/browser-results", reporter: "list",
  use: { baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1440, height: 900 }, reducedMotion: "reduce", trace: "retain-on-failure" },
  webServer: { command: `pnpm vite --host 127.0.0.1 --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: false, timeout: 45_000 },
});
