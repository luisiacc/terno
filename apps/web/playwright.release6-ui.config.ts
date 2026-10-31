import { defineConfig, devices } from "@playwright/test";
import type { DesignId } from "@terno/core";

const port = Number(process.env.E2E_PORT ?? 58210);
export default defineConfig<{ design: DesignId | null }>({
  testDir: "e2e",
  testMatch: ["attachment-controls.spec.ts", "dnd.spec.ts", "reply-subject.spec.ts", "account-errors.spec.ts", "autocomplete.spec.ts", "perf.spec.ts"],
  globalSetup: "./e2e/account-errors.setup.ts",
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 8_000, toHaveScreenshot: { maxDiffPixelRatio: 0.002, animations: "disabled", caret: "hide", scale: "device" } },
  outputDir: `/tmp/terno-release6-ui/${process.env.R6_STAGE ?? "run"}-results`,
  snapshotPathTemplate: "{testDir}/__screenshots__/{testFilePath}/{arg}{ext}",
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"], baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2,
    locale: "en-US", timezoneId: "America/Mexico_City", colorScheme: "light", reducedMotion: "reduce", trace: "retain-on-failure",
    proxy: { server: "http://127.0.0.1:9", bypass: "localhost,127.0.0.1" },
    launchOptions: { args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1"] },
  },
  projects: [
    { name: "e2e", testIgnore: /perf\.spec\.ts/ },
    ...(["lumen", "atelier"] as const).map((design) => ({
      name: `e2e-${design}`, testIgnore: /perf\.spec\.ts/, grep: /@design/, use: { design },
      snapshotPathTemplate: `{testDir}/__screenshots__/${design}/{testFilePath}/{arg}{ext}`,
    })),
    { name: "perf", testMatch: /perf\.spec\.ts/, fullyParallel: false, workers: 1, use: { deviceScaleFactor: 1, trace: "off" } },
  ],
  webServer: {
    command: `VITE_RENDER_PROBE=1 pnpm vite --port ${port} --strictPort --host 127.0.0.1`,
    url: `http://127.0.0.1:${port}`, reuseExistingServer: false, timeout: 30_000,
  },
});
