import { defineConfig } from "@playwright/test";
const port = Number(process.env.WEB_PORT ?? 56030);
export default defineConfig({
  testDir: "e2e-web/w09-signature", testMatch: "*.dev.spec.ts", workers: 1, retries: 0, timeout: 60_000,
  outputDir: `/tmp/terno-w09-signature-${port}/results`, reporter: "list",
  use: { baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1440, height: 900 }, bypassCSP: true, reducedMotion: "reduce", serviceWorkers: "block" },
  webServer: { command: `VITE_TARGET=web VITE_WEB_DEMO=1 pnpm vite --host 127.0.0.1 --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: false, timeout: 45_000 },
});
