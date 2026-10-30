import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
const port = Number(process.env.E2E_PORT ?? 57510);
const url = `http://127.0.0.1:${port}`;
export default defineConfig({
  ...base,
  use: { ...base.use, baseURL: url },
  outputDir: "/tmp/terno-print-escape/results",
  webServer: {
    command: `VITE_RENDER_PROBE=1 pnpm vite --mode development --port ${port} --strictPort --host 127.0.0.1`,
    url, reuseExistingServer: false, timeout: 120_000,
  },
});
