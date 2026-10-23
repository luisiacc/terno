import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
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
