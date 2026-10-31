import { defineConfig } from "vitest/config";

// Explicit opt-in: installed Electron and the task's network guard are prerequisites.
export default defineConfig({ test: { include: ["apps/desktop/src/backend-retirement.native.ts"], environment: "node", testTimeout: 20_000 } });
