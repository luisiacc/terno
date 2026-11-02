/** Plan 116 at 50,000 threads on SQLite (the workload is the store's conformance one: forwards-perf.ts). */
import { measureForwards } from "@terno/store/conformance";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vitest";
import { openDatabase } from "./index";
import { SqlMailStore } from "./sql-store";
import { BUDGET_MULTIPLIER } from "./test/perf";

it("forwards: a live slice's planning and the queue's reads hold at 50,000 threads", async () => {
  const dir = mkdtempSync(join(tmpdir(), "terno-forwards-perf-"));
  const store = new SqlMailStore(openDatabase(join(dir, "perf.db")));
  try {
    await measureForwards(store, { now: Date.UTC(2026, 10, 1, 12), budget: BUDGET_MULTIPLIER, log: (line) => process.stderr.write(`[50k SQL forwards] ${line}\n`) });
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 600_000);
