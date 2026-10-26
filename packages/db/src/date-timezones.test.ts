import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { DATE_ZONES } from "./test/search-dates";
import { sqliteDriver } from "./index";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../../../", import.meta.url));

describe("local date boundaries in isolated timezone processes", () => {
  it.each(DATE_ZONES)("qualifies parser → store → RPC in %s", async (zone) => {
    const project = sqliteDriver().id === "wasm-memory" ? "db-wasm" : "unit";
    const files = ["packages/db/src/search-dates.test.ts", ...(project === "unit" ? ["packages/idb/src/search-dates.test.ts", "packages/backend/src/search-dates.int.test.ts"] : [])];
    const { stdout } = await run(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "--project", project, ...files], {
      cwd: root, env: { ...process.env, TZ: zone }, timeout: 45_000, maxBuffer: 2_000_000,
    });
    const days = ["America/New_York", "Europe/Berlin", "Australia/Lord_Howe", "America/Sao_Paulo"].includes(zone) ? 2 : 1;
    expect(stdout).toMatch(new RegExp(`Tests\\s+${days * (project === "unit" ? 30 : 12)} passed`));
  }, 60_000);
});
