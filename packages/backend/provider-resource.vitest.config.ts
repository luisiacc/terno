import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/backend/src/provider-resource-boundaries.int.test.ts", "packages/mail/src/provider-resource-ownership.test.ts"],
    environment: "node",
    testTimeout: 20_000,
    fileParallelism: false,
  },
});
