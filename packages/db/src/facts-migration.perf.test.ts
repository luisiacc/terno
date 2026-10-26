/**
 * Plan 17's migration (v14) on what an install holds: a v13 database of
 * 50,000 conversations, copied row by row from one seeded today. The
 * migration rewrites no row (two NULL columns, one constant one, a table)
 * and builds five indexes; it is timed as the app opens the file. Then the
 * first slices of the backfill on it, cold, each within the backend's
 * two-frame stall budget.
 */
import { generateDataset } from "@terno/mock-data";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { openDatabase } from "./index";
import { seedDataset } from "./seed";
import { SqlMailStore } from "./sql-store";
import { writeLegacyCopy } from "./test/legacy";
import { BUDGET_MULTIPLIER as MULT, report, type Stat } from "./test/perf";

const NOW = Date.UTC(2026, 9, 22, 15, 30);
const MIGRATION_MS = 1000;
const SLICE_MS = 32;
const dir = mkdtempSync(join(tmpdir(), "terno-v14-perf-"));
const stats: Stat[] = [];
afterAll(() => {
  report("facts-migration.json", "Plan 17: migration v14 at 50,000 threads", {}, stats);
  rmSync(dir, { recursive: true, force: true });
});

it(`migrates a v13 mailbox of 50,000 conversations in ≤ ${MIGRATION_MS} ms; the first backfill slices stay within ${SLICE_MS} ms`, { timeout: 1_800_000 }, async () => {
  const source = openDatabase(join(dir, "source.db"));
  seedDataset(source, generateDataset({ threads: 50_000, accounts: 4, seed: 9, now: NOW, bodyScale: 1 }), { now: NOW, chunkSize: 2000 });
  const v13 = join(dir, "v13.db");
  writeLegacyCopy(source, v13, 13);
  const threads = source.get<{ c: number }>("SELECT count(*) AS c FROM threads")!.c;
  source.close();
  // the best of three copies: a migration is measured once per file
  const times: number[] = [];
  let store: SqlMailStore | null = null;
  for (let i = 0; i < 3; i++) {
    const path = join(dir, `v13-${i}.db`);
    const copy = openDatabase(v13, { readonly: true });
    copy.exec(`VACUUM INTO '${path}'`);
    copy.close();
    const t = performance.now();
    const db = openDatabase(path);
    times.push(performance.now() - t);
    // the last copy stays open: its first backfill slices are timed next
    if (i < 2) db.close();
    else store = new SqlMailStore(db, { checkpointWorker: true });
  }
  const best = Math.min(...times);
  stats.push({ name: `open + migrate v13 → v14, ${threads} threads: ${times.map((x) => x.toFixed(0)).join("/")} ms`, budgetMs: MIGRATION_MS, p50: best, p95: best, max: Math.max(...times), iterations: times.length });
  expect(best).toBeLessThanOrEqual(MIGRATION_MS * MULT);
  const s = store!;
  try {
    expect(await s.facts.idle()).toBe(false);
    const slices: number[] = [];
    for (let i = 0; i < 40; i++) {
      const t = performance.now();
      await s.facts.backfill({ limit: 64 });
      slices.push(performance.now() - t);
      await s.settle?.();
    }
    const worst = Math.max(...slices);
    stats.push({ name: `first 40 backfill slices of 64, cold: slowest ${worst.toFixed(1)} ms`, budgetMs: SLICE_MS, p50: worst, p95: worst, max: worst, iterations: slices.length });
    expect(worst).toBeLessThanOrEqual(SLICE_MS * MULT);
  } finally {
    await s.close();
  }
});
