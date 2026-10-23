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
          include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
          exclude: ["**/*.perf.test.ts", "**/node_modules/**"],
          environment: "node",
          testTimeout: 20_000,
        },
      },
      {
        test: {
          name: "perf",
          include: ["packages/*/src/**/*.perf.test.ts"],
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
