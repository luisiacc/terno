/** Plan 132 at 50,000 threads on SQLite (the workload is the store's conformance one: ai-summaries-perf.ts). */
import { measureAiSummaries } from "@terno/store/conformance";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vitest";
import { openDatabase } from "./index";
import { SqlMailStore } from "./sql-store";
import { BUDGET_MULTIPLIER } from "./test/perf";

it("summaries: marking a live slice and the worker's and reader's reads hold at 50,000 threads", async () => {
  const dir = mkdtempSync(join(tmpdir(), "terno-summaries-perf-"));
  const store = new SqlMailStore(openDatabase(join(dir, "perf.db")));
  try {
    await measureAiSummaries(store, { now: Date.UTC(2026, 10, 1, 12), budget: BUDGET_MULTIPLIER, log: (line) => process.stderr.write(`[50k SQL summaries] ${line}\n`) });
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 600_000);
