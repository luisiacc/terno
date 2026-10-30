import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

/**
 * Plan 76 usability pass: five personas drop files into the composer. Dev
 * only (a `.dev.ts` file, outside the default suite); it observes and logs
 * (findings in $PERSONAS_OUT, default /tmp/terno-personas) more than it gates.
 *
 *   E2E_PORT=5293 npx playwright test -c playwright.composer-drop-personas.config.ts --project=e2e
 */
export default defineConfig({
  ...base,
  testMatch: "composer-drop-personas.dev.ts",
  outputDir: "../../test-results/e2e-personas",
});
