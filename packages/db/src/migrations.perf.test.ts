/**
 * Plan 112: an update's first start waits for its migrations, so each one stays quick at what an install holds: a
 * mailbox of 50,000 conversations. Every step since v25 is timed on its own (plan 68's test covers v24), on a copy
 * written at the version before it; then the whole way from v24 through `openDatabase`. A step that rewrites data
 * inline fails here: its data work belongs in the backend's background slices (as v24's and v41's backfills).
 */
import { generateDataset } from "@terno/mock-data";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { openDatabase } from "./index";
import { MIGRATIONS, SCHEMA_VERSION } from "./migrations";
import { nodeSqliteDriver } from "./node-driver";
import { seedDataset } from "./seed";
import { Db } from "./sqlite";
import { writeLegacyCopy } from "./test/legacy";
import { BUDGET_MULTIPLIER as MULT, report, type Stat } from "./test/perf";

const NOW = Date.UTC(2026, 10, 1, 15, 30);
const FIRST = 25;
const STEP_MS = 1000;
const TOTAL_MS = 3000;
const dir = mkdtempSync(join(tmpdir(), "terno-migrations-perf-"));
const stats: Stat[] = [];
afterAll(() => {
  report("migrations.json", "Plan 112: every migration since v25 at 50,000 threads", {}, stats);
  rmSync(dir, { recursive: true, force: true });
});

it(`each migration since v${FIRST} runs in ≤ ${STEP_MS} ms at 50,000 conversations, and the whole way from v${FIRST - 1} in ≤ ${TOTAL_MS} ms`, { timeout: 3_600_000 }, () => {
  const source = openDatabase(join(dir, "source.db"));
  seedDataset(source, generateDataset({ threads: 50_000, accounts: 4, seed: 11, now: NOW, bodyScale: 1 }), { now: NOW, chunkSize: 2000 });
  const slow: string[] = [];
  try {
    for (const m of MIGRATIONS.filter((x) => x.version >= FIRST)) {
      const path = join(dir, `v${m.version - 1}.db`);
      writeLegacyCopy(source, path, m.version - 1);
      const db = new Db(nodeSqliteDriver, path);
      try {
        // the step as migrate() runs it: its SQL and the version, in one transaction
        const t = performance.now();
        db.tx(() => {
          db.exec(m.sql);
          db.exec(`PRAGMA user_version = ${m.version}`);
        });
        const ms = performance.now() - t;
        stats.push({ name: `v${m.version} (${m.name}): ${ms.toFixed(0)} ms`, budgetMs: STEP_MS, p50: ms, p95: ms, max: ms, iterations: 1 });
        if (ms > STEP_MS * MULT) slow.push(`v${m.version} ${m.name}: ${ms.toFixed(0)} ms`);
      } finally {
        db.close();
        rmSync(path, { force: true });
        rmSync(`${path}-wal`, { force: true });
        rmSync(`${path}-shm`, { force: true });
      }
    }
    const from = join(dir, `v${FIRST - 1}.db`);
    writeLegacyCopy(source, from, FIRST - 1);
    const t = performance.now();
    const db = openDatabase(from);
    const total = performance.now() - t;
    expect(db.get<{ user_version: number }>("PRAGMA user_version")!.user_version).toBe(SCHEMA_VERSION);
    db.close();
    stats.push({ name: `open + migrate v${FIRST - 1} → v${SCHEMA_VERSION}: ${total.toFixed(0)} ms`, budgetMs: TOTAL_MS, p50: total, p95: total, max: total, iterations: 1 });
    expect(slow, "migrations over their budget").toEqual([]);
    expect(total).toBeLessThanOrEqual(TOTAL_MS * MULT);
  } finally {
    source.close();
  }
});
