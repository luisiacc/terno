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
          setupFiles: ["packages/backend/src/test/sqlite-template.fixture.ts"],
          include: ["packages/*/src/**/*.test.{ts,tsx}", "apps/*/src/**/*.test.{ts,tsx}", "scripts/ui-rating/*.test.ts"],
          exclude: ["**/*.perf.test.ts", "**/node_modules/**"],
          environment: "node",
          testTimeout: 20_000,
        },
      },
      {
        // The store contract again on SQLite-WASM, the web's engine (in-memory images in Node), with what the engine can decide:
        // its FTS5 and SQLite build (search, migrations, the contract's SQL), its driver (bindings, functions, images, body
        // preparation). A file goes when the engine can't change its result.
        test: {
          name: "db-wasm",
          include: ["packages/db/src/**/*.test.ts"],
          exclude: [
            "**/*.perf.test.ts", "**/node_modules/**",
            // native pragmas, live disk lifecycle and source scans; storage-images covers WASM persistence
            "packages/db/src/sqlite.test.ts", "packages/db/src/storage.test.ts", "packages/db/src/portable.test.ts", "packages/db/src/upgrade*.test.ts",
            // these drive node:sqlite themselves whatever the project; the contract's `upgraded` case walks the migrations here
            "packages/db/src/migrations.test.ts", "packages/db/src/open-errors.test.ts",
            // a zone decides in the parser, and a store gets two epochs; the contract's date queries run here
            "packages/db/src/date-timezones.test.ts", "packages/db/src/search-dates.test.ts",
            // the RAM index is JavaScript fed by the search log: the contract's replica proves the log here, its search cases FTS5
            "packages/db/src/instant.test.ts", "packages/db/src/instant-store.test.ts",
            // the same triggers and transactions over the same SQL, with the contract's folder and removal cases here
            "packages/db/src/folder-unread.test.ts", "packages/db/src/sql-lifecycle.test.ts",
            // the perf gates' helpers
            "packages/db/src/test/timing.test.ts", "packages/db/src/test/perf.test.ts",
          ],
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
          globalSetup: ["packages/backend/scripts/test-worker-setup.mjs", "packages/backend/src/test/perf-snapshots.ts"],
          include: ["packages/*/src/**/*.perf.test.ts", "apps/*/src/**/*.perf.test.ts"],
          // memory gates measure the heap after a full collection
          execArgv: ["--expose-gc"],
          environment: "node",
          testTimeout: 600_000,
          hookTimeout: 600_000,
          // plan 139: three files at a time on 12 cores, each with a core of its own; never more than the machine has free,
          // since timing samples must not compete for CPU
          fileParallelism: true,
          maxWorkers: 3,
          sequence: { concurrent: false },
        },
      },
    ],
  },
});
