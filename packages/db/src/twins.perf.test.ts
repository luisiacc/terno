/** Plan 65 (Codex R20): an ID-less message's twins, by exactly its envelope (`messages_twins`), at 50,000 in a cohort. */
import { twinLookupsMs } from "@terno/store/conformance";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openDatabase } from "./index";
import { SqlMailStore } from "./sql-store";
import { BUDGET_MULTIPLIER } from "./test/perf";

it("250 twin lookups among 50,000 ID-less messages of one sender, date and size: under 25 ms", { timeout: 600_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "terno-twins-"));
  const store = new SqlMailStore(openDatabase(join(dir, "t.db")));
  try {
    const ms = await twinLookupsMs(store);
    console.log(`250 twin lookups: ${ms.toFixed(2)} ms`);
    expect(ms).toBeLessThanOrEqual(25 * BUDGET_MULTIPLIER);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
