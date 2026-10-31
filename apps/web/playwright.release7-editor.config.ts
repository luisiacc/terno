import base from "./playwright.config";
import { defineConfig } from "@playwright/test";
const port = Number(process.env.E2E_PORT ?? 59110);
export default defineConfig({
  ...base,
  workers: 1,
  testMatch: ["composer-drop.spec.ts", "autocomplete-runtime.spec.ts", "autocomplete-perf.spec.ts"],
  outputDir: "/tmp/terno-r7-editor-a894bf8b/browser-results",
  use: { ...base.use, baseURL: `http://127.0.0.1:${port}`, launchOptions: { args: ["--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=localhost;127.0.0.1;[::1]"] } },
  projects: [{ name: "editor", fullyParallel: false, workers: 1, use: { deviceScaleFactor: 1, trace: "off" } }],
  webServer: { command: `VITE_RENDER_PROBE=1 pnpm vite --host 127.0.0.1 --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: false, timeout: 120_000 },
});
