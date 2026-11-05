/**
 * Plan 68 (Codex R13): migration v24 on what an install holds: a v23 database of 57,000 conversations whose Gmail
 * messages carry 20 user labels each (a million memberships) and one conversation holds 50,000 of them (Codex R14: a
 * thread count bounds no slice). The migration writes none of them: it's timed as the app opens the file; then the
 * backfill drains in the backend's slices, each within a frame, to every membership. It stays at this size: what
 * a slice writes costs more as its table grows, so the tables are the ones a slice would meet on such an install.
 */
import { afterAll, expect, it } from "vitest";
import { startCheckpointWorker } from "./checkpoint";
import { rebuildFolders } from "./folders";
import { openDatabase } from "./index";
import { nodeSqliteDriver } from "./node-driver";
import { Db } from "./sqlite";
import { BUDGET_MULTIPLIER as MULT, report, type Stat } from "./test/perf";
import { copyLegacyMailbox, LARGE_MAILBOX, scratchDir } from "./test/perf-mailbox";
import { sampleSync, settle, type Sample } from "./test/timing";

const MIGRATION_MS = 1000;
const SLICE_MS = 16;
const scratch = scratchDir("v24-perf");
const stats: Stat[] = [];
afterAll(() => {
  report("folders-migration.json", "Plan 68: migration v24 at 57,000 threads", {}, stats);
  scratch.done();
});

it(`migrates a v23 mailbox of 57,000 conversations (one of 50,000 messages), 20 labels a message, in ≤ ${MIGRATION_MS} ms; its backfill slices stay within ${SLICE_MS} ms`, { timeout: 300_000 }, async () => {
  const v23 = scratch.path("v23.db");
  copyLegacyMailbox(LARGE_MAILBOX, 23, v23);
  const raw = new Db(nodeSqliteDriver, v23);
  const labels = JSON.stringify(["INBOX", ...Array.from({ length: 20 }, (_, i) => `Label_${i}`)]);
  raw.tx(() => {
    raw.run("UPDATE messages SET gmail_labels = ? WHERE account_id IN (SELECT id FROM accounts WHERE kind = 'gmail')", labels);
    // Codex R14: and one conversation of 50,000 of them (a thread count bounds no slice)
    raw.run("UPDATE messages SET thread_id = (SELECT min(thread_id) FROM messages WHERE gmail_labels IS NOT NULL) WHERE id IN (SELECT id FROM messages WHERE gmail_labels IS NOT NULL ORDER BY id LIMIT 50000)");
  });
  expect(raw.get<{ c: number }>("SELECT count(*) AS c FROM messages WHERE thread_id = (SELECT min(thread_id) FROM messages WHERE gmail_labels IS NOT NULL)")!.c).toBeGreaterThanOrEqual(50_000);
  const expected = raw.get<{ c: number }>("SELECT count(DISTINCT thread_id) * 20 AS c FROM messages WHERE gmail_labels IS NOT NULL AND is_trash = 0 AND is_spam = 0")!.c;
  expect(expected).toBeGreaterThan(100_000);
  raw.close();
  const t = performance.now();
  const db = openDatabase(v23);
  const migrateMs = performance.now() - t;
  const checkpoints = startCheckpointWorker(db)!;
  try {
    stats.push({ name: `open + migrate v23 → v24: ${migrateMs.toFixed(0)} ms`, budgetMs: MIGRATION_MS, p50: migrateMs, p95: migrateMs, max: migrateMs, iterations: 1 });
    expect(migrateMs).toBeLessThanOrEqual(MIGRATION_MS * MULT);
    const samples: Sample[] = [];
    for (let more = true; more; ) {
      const s = sampleSync(() => (more = rebuildFolders(db, 250).more));
      samples.push(s);
      // as the backend's runner does between slices
      await checkpoints.settle();
      await new Promise((r) => setImmediate(r));
    }
    // a busy machine's rare descheduled slice counts at its CPU time (timing.ts); a slow slice of ours fails either way
    const slices = settle(samples).ms.sort((a, b) => a - b);
    stats.push({ name: `the backfill: ${slices.length} slices, ${slices.reduce((a, b) => a + b, 0).toFixed(0)} ms in all`, budgetMs: SLICE_MS, p50: slices[slices.length >> 1]!, p95: slices[Math.floor(slices.length * 0.95)]!, max: slices.at(-1)!, iterations: slices.length });
    expect(slices.at(-1)!, "the longest backfill slice").toBeLessThanOrEqual(SLICE_MS * MULT);
    expect(db.get<{ c: number }>("SELECT count(*) AS c FROM thread_folders")!.c).toBe(expected);
  } finally {
    await checkpoints.stop();
    db.close();
  }
});
