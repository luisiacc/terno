import { defineConfig } from "@playwright/test";

const port = Number(process.env.WEB_PORT ?? 62020);
export default defineConfig({
  testDir: "e2e-web/worker-retirement", testMatch: "*.dev.spec.ts", workers: 1, retries: 0, timeout: 60_000,
  outputDir: `/tmp/terno-w05-retirement/results-${port}`, reporter: [["list"], ["json", { outputFile: `/tmp/terno-w05-retirement/report-${port}.json` }]],
  use: { baseURL: `http://127.0.0.1:${port}`, bypassCSP: true, serviceWorkers: "block", reducedMotion: "reduce" },
  webServer: { command: `VITE_TARGET=web VITE_WEB_DEMO=1 pnpm vite --config vite.worker-retirement.config.ts --host 127.0.0.1 --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: false, timeout: 45_000 },
});
