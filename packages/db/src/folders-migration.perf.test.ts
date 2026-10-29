/**
 * Plan 68 (Codex R13): migration v24 on what an install holds: a v23 database of 50,000 conversations whose Gmail
 * messages carry 20 user labels each (a million memberships). The migration writes none of them: it's timed as the
 * app opens the file; then the backfill drains in the backend's slices, each within a frame, to every membership.
 */
import { generateDataset } from "@terno/mock-data";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { startCheckpointWorker } from "./checkpoint";
import { rebuildFolders } from "./folders";
import { openDatabase } from "./index";
import { seedDataset } from "./seed";
import { writeLegacyCopy } from "./test/legacy";
import { BUDGET_MULTIPLIER as MULT, report, type Stat } from "./test/perf";
import { sampleSync, settle, type Sample } from "./test/timing";

const NOW = Date.UTC(2026, 9, 22, 15, 30);
const MIGRATION_MS = 1000;
const SLICE_MS = 16;
const dir = mkdtempSync(join(tmpdir(), "terno-v24-perf-"));
const stats: Stat[] = [];
afterAll(() => {
  report("folders-migration.json", "Plan 68: migration v24 at 50,000 threads", {}, stats);
  rmSync(dir, { recursive: true, force: true });
});

it(`migrates a v23 mailbox of 50,000 conversations (one of 50,000 messages), 20 labels a message, in ≤ ${MIGRATION_MS} ms; its backfill slices stay within ${SLICE_MS} ms`, { timeout: 1_800_000 }, async () => {
  const source = openDatabase(join(dir, "source.db"));
  seedDataset(source, generateDataset({ threads: 50_000, accounts: 4, seed: 9, now: NOW, bodyScale: 1 }), { now: NOW, chunkSize: 2000 });
  const labels = JSON.stringify(["INBOX", ...Array.from({ length: 20 }, (_, i) => `Label_${i}`)]);
  source.run("UPDATE messages SET gmail_labels = ? WHERE account_id IN (SELECT id FROM accounts WHERE kind = 'gmail')", labels);
  // Codex R14: and one conversation of 50,000 of them (a thread count bounds no slice)
  source.run("UPDATE messages SET thread_id = (SELECT min(thread_id) FROM messages WHERE gmail_labels IS NOT NULL) WHERE id IN (SELECT id FROM messages WHERE gmail_labels IS NOT NULL ORDER BY id LIMIT 50000)");
  expect(source.get<{ c: number }>("SELECT count(*) AS c FROM messages WHERE thread_id = (SELECT min(thread_id) FROM messages WHERE gmail_labels IS NOT NULL)")!.c).toBeGreaterThanOrEqual(50_000);
  const expected = source.get<{ c: number }>("SELECT count(DISTINCT thread_id) * 20 AS c FROM messages WHERE gmail_labels IS NOT NULL AND is_trash = 0 AND is_spam = 0")!.c;
  expect(expected).toBeGreaterThan(100_000);
  const v23 = join(dir, "v23.db");
  writeLegacyCopy(source, v23, 23);
  source.close();
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
