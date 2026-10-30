import { defineConfig, devices } from "@playwright/test";
const port = Number(process.env.E2E_PORT ?? 57060);
export default defineConfig({
  testDir: "e2e", globalSetup: "./e2e/global-setup.ts", retries: 0,
  timeout: 45000, expect: { timeout: 8000 }, reporter: [["list"]],
  testMatch: ["revealed-field-focus.dev.ts", "early-compose-input.dev.ts", "focus-ring.spec.ts"],
  projects: [{ name: "reveal" }], workers: 2,
  outputDir: "/tmp/terno-revealed-focus/browser",
  use: { ...devices["Desktop Chrome"], baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1440, height: 900 }, locale: "en-US", reducedMotion: "reduce", trace: "retain-on-failure", proxy: { server: "http://127.0.0.1:9", bypass: "localhost,127.0.0.1" }, launchOptions: { args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1"] } },
  webServer: { command: `VITE_RENDER_PROBE=1 pnpm vite --port ${port} --strictPort --host 127.0.0.1`, url: `http://127.0.0.1:${port}`, reuseExistingServer: false, timeout: 30000 },
});
