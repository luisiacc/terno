import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

/**
 * The conformance page (e2e-web/conformance): the repo's suites bundled for a
 * dedicated worker, with `vitest` resolved to a small runner and vitest's own
 * `expect`.
 */
export default defineConfig({
  root: import.meta.dirname,
  base: "./",
  resolve: {
    alias: [
      { find: /^vitest$/, replacement: fileURLToPath(new URL("./shim.ts", import.meta.url)) },
      { find: /^vitest-expect$/, replacement: fileURLToPath(import.meta.resolve("vitest")) },
    ],
  },
  optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"] },
  worker: { format: "es" },
  build: { target: "chrome140", outDir: fileURLToPath(new URL("../../dist-web-conformance", import.meta.url)), emptyOutDir: true, minify: false, sourcemap: false },
});
