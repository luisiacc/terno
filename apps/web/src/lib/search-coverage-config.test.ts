import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const cli = createRequire(import.meta.url).resolve("@playwright/test/cli");
const cwd = fileURLToPath(new URL("../../", import.meta.url));

it("collects local coverage only in the dev configuration", () => {
  const list = (config: string, project: string) => execFileSync(process.execPath, [
    cli, "test", "-c", config, `--project=${project}`, "--list", "--pass-with-no-tests", "search-coverage\\.(spec|dev)\\.ts",
  ], { cwd, encoding: "utf8", env: { ...process.env, E2E_PORT: "54660", WEB_PORT: "54670" } });
  expect(list("playwright.config.ts", "e2e")).toContain("Total: 0 tests in 0 files");
  expect(list("playwright.search-coverage.config.ts", "coverage")).toContain("Total: 8 tests in 1 file");
});
