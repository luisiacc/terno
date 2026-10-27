import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// the renderer's own "~/" imports (apps/web/vite.config.ts), for its unit tests
const webSrc = fileURLToPath(new URL("./apps/web/src/", import.meta.url));

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias: [{ find: /^~\//, replacement: webSrc }] },
        test: {
          name: "unit",
          globalSetup: ["packages/backend/scripts/test-worker-setup.mjs"],
          include: ["packages/*/src/**/*.test.{ts,tsx}", "apps/*/src/**/*.test.{ts,tsx}"],
          exclude: ["**/*.perf.test.ts", "**/node_modules/**"],
          environment: "node",
          testTimeout: 20_000,
        },
      },
      {
        // the db and store suites again on SQLite-WASM, the web's engine (in-memory images in Node)
        test: {
          name: "db-wasm",
          include: ["packages/db/src/**/*.test.ts"],
          // node:sqlite specifics (driver pragmas, the checkpoint worker) and source scans
          exclude: ["**/*.perf.test.ts", "packages/db/src/sqlite.test.ts", "packages/db/src/portable.test.ts", "**/node_modules/**"],
          setupFiles: ["packages/db/src/test/wasm-setup.ts"],
          environment: "node",
          testTimeout: 60_000,
          hookTimeout: 180_000,
        },
      },
      {
        // timing gates: `pnpm test:perf` runs this project alone (`pnpm test` leaves it out so nothing competes for CPU)
        resolve: { alias: [{ find: /^~\//, replacement: webSrc }] },
        test: {
          name: "perf",
          globalSetup: ["packages/backend/scripts/test-worker-setup.mjs"],
          include: ["packages/*/src/**/*.perf.test.ts", "apps/*/src/**/*.perf.test.ts"],
          // memory gates measure the heap after a full collection
          execArgv: ["--expose-gc"],
          environment: "node",
          testTimeout: 600_000,
          hookTimeout: 600_000,
          // timing samples must not compete for CPU
          fileParallelism: false,
          sequence: { concurrent: false },
        },
      },
    ],
  },
});
