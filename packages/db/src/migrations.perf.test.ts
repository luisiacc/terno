/**
 * Plan 112: an update's first start waits for its migrations, so each one stays quick at what an install holds: a
 * mailbox of 57,000 conversations. One copy at v24 is walked step by step, each step's SQL timed as migrate() runs it,
 * with what a step's new tables hold on such an install put in afterwards (untimed) for the steps after it. A second,
 * untouched copy is then opened through `openDatabase`: the real startup, which a walked copy can't give (it has nothing
 * left to migrate). A step that rewrites data inline fails here: its data work belongs in the backend's background
 * slices (as v24's and v41's backfills).
 */
import { afterAll, expect, it } from "vitest";
import { openDatabase } from "./index";
import { MIGRATIONS, SCHEMA_VERSION } from "./migrations";
import { nodeSqliteDriver } from "./node-driver";
import { Db } from "./sqlite";
import { BUDGET_MULTIPLIER as MULT, report, type Stat } from "./test/perf";
import { copyLegacyMailbox, copyMailbox, LARGE_MAILBOX, scratchDir } from "./test/perf-mailbox";

const FIRST = 25;
const STEP_MS = 1000;
const TOTAL_MS = 3000;
const scratch = scratchDir("migrations-perf");
const stats: Stat[] = [];
afterAll(() => {
  report("migrations.json", "Plan 112: every migration since v25 at 57,000 threads", {}, stats);
  scratch.done();
});

const tablesOf = (db: Db, schema = "main") => db.all<{ name: string }>(`SELECT name FROM ${schema}.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'messages_fts%'`).map((r) => r.name);

/** Rows today's mailbox holds in a table this step made, in the columns it has so far (later steps add the rest). */
function fillNewTables(db: Db, before: readonly string[]): void {
  for (const table of tablesOf(db).filter((t) => !before.includes(t))) {
    const here = db.all<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`).map((c) => c.name);
    const there = new Set(db.all<{ name: string }>(`SELECT name FROM pragma_table_info('${table}', 'src')`).map((c) => c.name));
    const list = here.filter((c) => there.has(c)).map((c) => `"${c}"`).join(", ");
    if (list) db.exec(`INSERT OR REPLACE INTO main."${table}" (${list}) SELECT ${list} FROM src."${table}"`);
  }
}

it(`each migration since v${FIRST} runs in ≤ ${STEP_MS} ms at 57,000 conversations, and the whole way from v${FIRST - 1} in ≤ ${TOTAL_MS} ms`, { timeout: 300_000 }, () => {
  const walked = scratch.path("walked.db");
  copyLegacyMailbox(LARGE_MAILBOX, FIRST - 1, walked);
  const today = scratch.path("today.db");
  copyMailbox(LARGE_MAILBOX, today);
  const db = new Db(nodeSqliteDriver, walked);
  const slow: string[] = [];
  try {
    db.exec("PRAGMA foreign_keys = OFF");
    db.run("ATTACH DATABASE ? AS src", today);
    const steps = MIGRATIONS.filter((x) => x.version >= FIRST);
    expect(steps.at(-1)!.version).toBe(SCHEMA_VERSION);
    for (const m of steps) {
      const before = tablesOf(db);
      // the step as migrate() runs it: its SQL and the version, in one transaction
      const t = performance.now();
      db.tx(() => {
        db.exec(m.sql);
        db.exec(`PRAGMA user_version = ${m.version}`);
      });
      const ms = performance.now() - t;
      stats.push({ name: `v${m.version} (${m.name}): ${ms.toFixed(0)} ms`, budgetMs: STEP_MS, p50: ms, p95: ms, max: ms, iterations: 1 });
      if (ms > STEP_MS * MULT) slow.push(`v${m.version} ${m.name}: ${ms.toFixed(0)} ms`);
      fillNewTables(db, before);
    }
  } finally {
    db.close();
  }
  const from = scratch.path("from.db");
  copyLegacyMailbox(LARGE_MAILBOX, FIRST - 1, from);
  const t = performance.now();
  const opened = openDatabase(from);
  const total = performance.now() - t;
  expect(opened.get<{ user_version: number }>("PRAGMA user_version")!.user_version).toBe(SCHEMA_VERSION);
  opened.close();
  stats.push({ name: `open + migrate v${FIRST - 1} → v${SCHEMA_VERSION}: ${total.toFixed(0)} ms`, budgetMs: TOTAL_MS, p50: total, p95: total, max: total, iterations: 1 });
  expect(slow, "migrations over their budget").toEqual([]);
  expect(total).toBeLessThanOrEqual(TOTAL_MS * MULT);
});
