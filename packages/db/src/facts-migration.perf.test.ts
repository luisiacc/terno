/**
 * The longest startup an install can have: a v13 database of 57,000 conversations migrated to today as the app opens
 * the file, which also times v14 (it rewrites no row: two NULL columns, a constant one, a table, five indexes). A
 * shipped migration's SQL can't change (migrations.test.ts locks it), but the runner, the pragmas and SQLite can.
 * Then the first slices of the facts backfill on it, cold, each within the backend's two-frame stall budget.
 */
import { afterAll, expect, it } from "vitest";
import { resetFacts } from "./facts";
import { openDatabase } from "./index";
import { SqlMailStore } from "./sql-store";
import { BUDGET_MULTIPLIER as MULT, report, type Stat } from "./test/perf";
import { copyLegacyMailbox, copyMailbox, LARGE_MAILBOX, scratchDir } from "./test/perf-mailbox";

const MIGRATION_MS = 1000;
const SLICE_MS = 32;
const scratch = scratchDir("v14-perf");
const stats: Stat[] = [];
afterAll(() => {
  report("facts-migration.json", "Plan 17: migration from v13 at 57,000 threads", {}, stats);
  scratch.done();
});

it(`migrates a v13 mailbox of 57,000 conversations to today in ≤ ${MIGRATION_MS} ms; the first backfill slices stay within ${SLICE_MS} ms`, { timeout: 300_000 }, async () => {
  // a migration runs once per file: over budget it's measured again on another copy (a regression is slow every time)
  const times: number[] = [];
  let db: ReturnType<typeof openDatabase> | null = null;
  for (let i = 0; i < 3 && !(times.length && Math.min(...times) <= MIGRATION_MS * MULT); i++) {
    db?.close();
    const path = scratch.path(`v13-${i}.db`);
    copyLegacyMailbox(LARGE_MAILBOX, 13, path);
    const t = performance.now();
    db = openDatabase(path);
    times.push(performance.now() - t);
  }
  const threads = db!.get<{ c: number }>("SELECT count(*) AS c FROM threads")!.c;
  db!.close();
  expect(threads).toBeGreaterThanOrEqual(50_000);
  const best = Math.min(...times);
  stats.push({ name: `open + migrate v13 → today, ${threads} threads: ${times.map((x) => x.toFixed(0)).join("/")} ms`, budgetMs: MIGRATION_MS, p50: best, p95: best, max: Math.max(...times), iterations: times.length });
  expect(best).toBeLessThanOrEqual(MIGRATION_MS * MULT);
  // the slices on today's mailbox with its facts as v14 leaves them, on a new connection: what a v13 file is once the host's
  // legacy-body upgrade (minutes at this size, and no part of a slice) has run
  const path = scratch.path("backfill.db");
  copyMailbox(LARGE_MAILBOX, path);
  const reset = openDatabase(path);
  resetFacts(reset);
  reset.close();
  const s = new SqlMailStore(openDatabase(path), { checkpointWorker: true });
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
