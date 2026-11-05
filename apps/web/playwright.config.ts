import { defineConfig, devices } from "@playwright/test";

/**
 * E2E + visual + UI-perf suites. The renderer is served as a PRODUCTION build
 * (vite preview) so perf numbers reflect what ships (React Compiler, prod React);
 * every test talks to a real backend over WebSocket (see e2e/fixtures.ts).
 */
// E2E_PORT lets a second checkout (a worktree) run its own suite alongside
const PORT = Number(process.env.E2E_PORT ?? 5180);
const OUT = process.env.E2E_PORT ? `dist-e2e-${PORT}` : "dist-e2e";

/**
 * What each design's project runs, beyond `e2e` (macOS), which runs every flow once: @design everywhere, and a design's own
 * structural variants only where it holds a value macOS lacks (designs.spec.ts says when to use which). Luma adds no value.
 */
const FLOWS = { lumen: /@design|@variant(?!-)/, atelier: /@design|@variant(?!-)/, luma: /@design/, graphite: /@design|@variant-graphite/ } as const;

export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: true,
  // plan 139: 8 flaked and ran no faster here (a machine shared with the rest of stage 2 is oversubscribed); 6 held
  workers: process.env.CI ? 2 : 6,
  retries: 0,
  timeout: 45_000,
  expect: {
    timeout: 8_000,
    toHaveScreenshot: { maxDiffPixelRatio: 0.002, animations: "disabled", caret: "hide", scale: "device" },
  },
  outputDir: "../../test-results/e2e",
  snapshotPathTemplate: "{testDir}/__screenshots__/{testFilePath}/{arg}{ext}",
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 900 },
    // plan 139: a spec with baselines asks for 2; drawing every test at twice the pixels costs them all
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "America/Mexico_City",
    colorScheme: "light",
    reducedMotion: "reduce",
    // plan 139: a trace walks the whole DOM on every action, for every test, to serve the few that fail. E2E_TRACE=1 to see one
    trace: process.env.E2E_TRACE ? "retain-on-failure" : "off",
    screenshot: "only-on-failure",
    // plan 139: a click that can't land fails its scenario, instead of using up the test and hiding the scenarios after it
    actionTimeout: 15_000,
  },
  projects: [
    { name: "e2e", testIgnore: /perf\.spec\.ts/ },
    // plan 15: the other designs, their baselines apart (plan 139: what a design can change, not every flow again)
    ...(["lumen", "atelier", "luma", "graphite"] as const).map((design) => ({
      name: `e2e-${design}`,
      testIgnore: /perf\.spec\.ts/,
      // E2E_DESIGN_ALL=1 runs every flow in this design (a full pass, not the gate)
      grep: process.env.E2E_DESIGN_ALL ? undefined : FLOWS[design],
      use: { design },
      snapshotPathTemplate: `{testDir}/__screenshots__/${design}/{testFilePath}/{arg}{ext}`,
    })),
    // perf runs alone (no CPU contention from parallel workers)
    // (no trace: its snapshots walk the whole DOM on every action, on the page's main thread, inside the timings)
    { name: "perf", testMatch: /perf\.spec\.ts/, dependencies: ["e2e"], fullyParallel: false, workers: 1, use: { deviceScaleFactor: 1, trace: "off", actionTimeout: 0 } },
  ],
  webServer: {
    // a test build (render probe on) in its own directory, so it never ships
    command: `VITE_RENDER_PROBE=1 pnpm vite build --outDir ${OUT} && pnpm vite preview --outDir ${OUT} --port ${PORT} --strictPort --host 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
