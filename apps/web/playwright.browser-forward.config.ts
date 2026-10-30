import config from "./playwright.config";
import { defineConfig } from "@playwright/test";
const port = Number(process.env.E2E_PORT ?? 56570);
export default defineConfig({ ...config,
  workers: 1,
  projects: [{ name: "e2e" }],
  testMatch: ["gmail-wire.spec.ts", "reply-subject.spec.ts"],
  globalSetup: "./e2e/reply-identity.setup.ts",
  use: { ...config.use, baseURL: `http://127.0.0.1:${port}` },
  outputDir: "/tmp/terno-browser-forward/browser-results",
  webServer: { command: `VITE_RENDER_PROBE=1 pnpm --config.verify-deps-before-run=false vite --port ${port} --strictPort --host 127.0.0.1`, url: `http://127.0.0.1:${port}`, reuseExistingServer: false, timeout: 30000 },
});
