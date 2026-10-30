import config from "./playwright.config";
import { defineConfig } from "@playwright/test";
const port = Number(process.env.E2E_PORT ?? 55560);
export default defineConfig({ ...config, projects: [{ name: "e2e", testMatch: "recipient-recovery.spec.ts" }], workers: 1,
  webServer: { command: `VITE_RENDER_PROBE=1 pnpm --config.verify-deps-before-run=false vite --port ${port} --strictPort --host 127.0.0.1`, url: `http://127.0.0.1:${port}`, reuseExistingServer: false, timeout: 30000 },
});
