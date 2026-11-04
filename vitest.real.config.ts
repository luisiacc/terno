import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Real models, real money: never part of `pnpm test`. See scripts/ai-real/harness.ts.
if (process.env.TERNO_AI_REAL !== "1") throw new Error("Refusing to run: these call real, paid models. Set TERNO_AI_REAL=1 to mean it.");

const pkg = (name: string) => fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  // zod for the evals' own judges; the workspace keeps it inside the packages that declare it
  resolve: { alias: { "@terno/ai": pkg("ai"), zod: fileURLToPath(new URL("./packages/ai/node_modules/zod/index.js", import.meta.url)) } },
  test: {
    include: ["scripts/ai-real/**/*.real.ts"],
    // one at a time: the ledger's ceiling is only exact without races
    fileParallelism: false,
    testTimeout: 180_000,
  },
});
