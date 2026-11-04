/** Plan 134 at 50,000 threads on SQLite (the workload is the store's conformance one: smart-categorization-perf.ts). */
import { measureCategoryEvidence } from "@terno/store/conformance";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vitest";
import { openDatabase } from "./index";
import { SqlMailStore } from "./sql-store";
import { BUDGET_MULTIPLIER } from "./test/perf";

it("categories: what the AI is told and an AI filing hold at 50,000 threads", async () => {
  const dir = mkdtempSync(join(tmpdir(), "terno-evidence-perf-"));
  const store = new SqlMailStore(openDatabase(join(dir, "perf.db")));
  try {
    await measureCategoryEvidence(store, { now: Date.UTC(2026, 10, 1, 12), budget: BUDGET_MULTIPLIER, log: (line) => process.stderr.write(`[50k SQL evidence] ${line}\n`) });
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 600_000);
