/** Plan 65 (Codex R20): an ID-less message's twins, by exactly its envelope (`messages_twins`), at 50,000 in a cohort. */
import { twinLookupsMs, twinPagesMs } from "@terno/store/conformance";
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

it("Codex R21: 50,000 twins of one envelope, paged 500 at a time: under 50 ms in all", { timeout: 600_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "terno-twins-"));
  const store = new SqlMailStore(openDatabase(join(dir, "t.db")));
  try {
    const ms = await twinPagesMs(store);
    console.log(`50,000 twins paged: ${ms.toFixed(2)} ms`);
    expect(ms).toBeLessThanOrEqual(50 * BUDGET_MULTIPLIER);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const what of ["lookups", "pages"] as const) {
  it(`Codex R27: with a reused Message-ID, ${what} stay as fast`, { timeout: 600_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "terno-twins-"));
    const store = new SqlMailStore(openDatabase(join(dir, "t.db")));
    try {
      const ms = what === "lookups" ? await twinLookupsMs(store, "<reused@example.test>") : await twinPagesMs(store, "<reused@example.test>");
      console.log(`Message-ID twin ${what}: ${ms.toFixed(2)} ms`);
      expect(ms).toBeLessThanOrEqual((what === "lookups" ? 25 : 50) * BUDGET_MULTIPLIER);
    } finally {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
