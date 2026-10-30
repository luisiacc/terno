import config from "./playwright.config";
import { defineConfig } from "@playwright/test";
const port = Number(process.env.E2E_PORT ?? 57350);
export default defineConfig({ ...config,
  workers: 1, retries: 0,
  testMatch: ["supported-groups.dev.ts", "perf.spec.ts"],
  projects: [{ name: "groups", testMatch: "supported-groups.dev.ts" }, { name: "original-gate", testMatch: "perf.spec.ts", use: { deviceScaleFactor: 1, trace: "off" } }],
  outputDir: "/tmp/terno-supported-groups/browser-results",
  use: { ...config.use, baseURL: `http://127.0.0.1:${port}`, trace: "off", proxy: { server: "http://127.0.0.1:9", bypass: "localhost,127.0.0.1" }, launchOptions: { args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1"] } },
  webServer: { command: `VITE_RENDER_PROBE=1 pnpm vite --port ${port} --strictPort --host 127.0.0.1`, url: `http://127.0.0.1:${port}`, reuseExistingServer: false, timeout: 30000 },
});
