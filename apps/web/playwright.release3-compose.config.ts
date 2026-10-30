import config from "./playwright.config";
import { defineConfig } from "@playwright/test";
const port = Number(process.env.E2E_PORT ?? 57140);
export default defineConfig({ ...config,
  workers: 1,
  testMatch: ["composer.spec.ts", "perf.spec.ts", "early-compose-input.dev.ts", "release3-compose-editor.dev.ts", "revealed-field-focus.dev.ts", "focus-ring.spec.ts"],
  outputDir: process.env.RELEASE3_RESULTS ?? "/tmp/terno-release3-compose-editor/browser-results",
  use: { ...config.use, baseURL: `http://127.0.0.1:${port}`, proxy: { server: "http://127.0.0.1:9", bypass: "localhost,127.0.0.1" }, launchOptions: { args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1"] } },
  webServer: { command: `VITE_RENDER_PROBE=1 pnpm vite --port ${port} --strictPort --host 127.0.0.1`, url: `http://127.0.0.1:${port}`, reuseExistingServer: false, timeout: 30000 },
});
