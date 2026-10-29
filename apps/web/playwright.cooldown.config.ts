import { defineConfig } from "@playwright/test";

const port = Number(process.env.E2E_PORT ?? 54340);

/** Focused cooldown verification against Vite dev; no application production build. */
export default defineConfig({
  testDir: "e2e",
  testMatch: "provider-cooldown.spec.ts",
  workers: 1,
  timeout: 45_000,
  outputDir: "../../test-results/provider-cooldown",
  reporter: "list",
  use: { baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1440, height: 900 }, locale: "en-US", reducedMotion: "reduce" },
  webServer: {
    command: `pnpm vite --port ${port} --strictPort --host 127.0.0.1`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 45_000,
  },
});
