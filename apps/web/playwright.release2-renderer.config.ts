import config from "./playwright.config";
import { defineConfig } from "@playwright/test";
const port = Number(process.env.E2E_PORT ?? 56840);
export default defineConfig({ ...config,
  testMatch: ["list-layout.spec.ts", "composer-account-recovery.spec.ts", "reply-subject.spec.ts", "early-compose-input.dev.ts"],
  outputDir: "/tmp/terno-release2-renderer/e2e-results",
  use: { ...config.use, proxy: { server: "http://127.0.0.1:9", bypass: "localhost,127.0.0.1" }, launchOptions: { args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1"] } },
  webServer: { command: `VITE_RENDER_PROBE=1 pnpm vite --port ${port} --strictPort --host 127.0.0.1`, url: `http://127.0.0.1:${port}`, reuseExistingServer: false, timeout: 30000 },
});
