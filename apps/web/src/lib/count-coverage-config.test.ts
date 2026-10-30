import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
const cli = createRequire(import.meta.url).resolve("@playwright/test/cli");
const cwd = fileURLToPath(new URL("../../", import.meta.url));
it("collects count coverage only in the dev configuration", () => {
  const list = (config: string) => execFileSync(process.execPath, [cli, "test", "-c", config, "--list", "--pass-with-no-tests", "count-coverage\\.(spec|dev)\\.ts"], { cwd, encoding: "utf8", env: { ...process.env, E2E_PORT: "55320", WEB_PORT: "55330" } });
  expect(list("playwright.config.ts")).toContain("Total: 0 tests in 0 files");
  expect(list("playwright.count-coverage.config.ts")).toContain("Total: 4 tests in 1 file");
});
