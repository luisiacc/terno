/**
 * Ingestion throughput through the store command, against the throughput of
 * the same workload before the storage work (75223cb: one transaction per
 * slice with ingestMessages and the filter pass, as Backend.ingestSliced ran
 * it). Machine speed and load cancel out: each round is timed against a
 * calibration (the same mail into a bare SQLite table with an FTS5 trigger)
 * run right before it, and the median ratio of six rounds is compared with the
 * ratio the old code reached on the reference machine.
 */
import { generateDataset } from "@terno/mock-data";
import type { IncomingMessage } from "@terno/store";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { openDatabase } from "./index";
import { seedDataset } from "./seed";
import { SqlMailStore } from "./sql-store";
import { BUDGET_MULTIPLIER, report, type Stat } from "./test/perf";

/** ingestion ÷ calibration throughput at 75223cb under vitest, median of its runs on a quiet M-series reference machine */
const BASELINE_RATIO = 0.204;
const TOLERANCE = 0.97;

const NOW = Date.UTC(2026, 9, 22, 15, 30);

/** msgs/s of a fixed SQLite workload shaped like ingestion (row + FTS5 insert per message, 200 per transaction) */
export function calibrate(mail: readonly { subject: string; bodyText: string | null }[]): number {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE m (id INTEGER PRIMARY KEY, subject TEXT, body TEXT);
    CREATE VIRTUAL TABLE f USING fts5(subject, body, tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3');
    CREATE TRIGGER m_ai AFTER INSERT ON m BEGIN INSERT INTO f (rowid, subject, body) VALUES (new.id, new.subject, new.body); END;`);
  const insert = db.prepare("INSERT INTO m (subject, body) VALUES (?, ?)");
  const t0 = performance.now();
  for (let i = 0; i < mail.length; i += 200) {
    db.exec("BEGIN");
    for (const m of mail.slice(i, i + 200)) insert.run(m.subject, m.bodyText ?? "");
    db.exec("COMMIT");
  }
  const rate = mail.length / ((performance.now() - t0) / 1000);
  db.close();
  return rate;
}
const dir = mkdtempSync(join(tmpdir(), "unica-ingest-perf-"));
const stats: Stat[] = [];
afterAll(() => {
  report("ingest.json", "Ingestion throughput", { baselineRatio: BASELINE_RATIO }, stats);
  rmSync(dir, { recursive: true, force: true });
});

// a run on a busy machine varies by ±3%: up to two more tries before a regression is reported
it(`ingests within ${Math.round((1 - TOLERANCE) * 100)}% of the pre-storage-work throughput`, { retry: 2, timeout: 600_000 }, async () => {
  const db = openDatabase(join(mkdtempSync(join(dir, "try-")), "i.db"));
  const store = new SqlMailStore(db);
  const seeded = seedDataset(db, generateDataset({ threads: 29_500, accounts: 8, seed: 2026, now: NOW, bodyScale: 4 }), { now: NOW });
  const rounds: { wall: number; cpu: number; calibration: number }[] = [];
  for (let round = 0; round < 6; round++) {
    const mail: IncomingMessage[] = generateDataset({ threads: 1_000, accounts: 8, seed: 77 + round, now: NOW, bodyScale: 4 }).messages.map((m) => ({
      ...m,
      providerMsgId: `r${round}-${m.providerMsgId}`,
      rfcMessageId: `r${round}-${m.rfcMessageId}`,
      references: m.references.map((r) => `r${round}-${r}`),
      inReplyTo: m.inReplyTo ? `r${round}-${m.inReplyTo}` : null,
      accountId: seeded.accountIds[m.accountIndex]!,
    }));
    const calibration = calibrate(mail);
    const t0 = performance.now();
    const cpu0 = process.cpuUsage();
    for (let i = 0; i < mail.length; i += 200) await store.sync.ingest(mail.slice(i, i + 200), { applyFilters: true, now: NOW, classifier: null });
    const cpu = process.cpuUsage(cpu0);
    rounds.push({ wall: mail.length / ((performance.now() - t0) / 1000), cpu: mail.length / ((cpu.user + cpu.system) / 1e6), calibration });
  }
  await store.close();
  const sorted = rounds.map((r) => r.wall / r.calibration).sort((a, b) => a - b);
  const median = (sorted[2]! + sorted[3]!) / 2;
  const ratio = median / BASELINE_RATIO;
  stats.push({
    name: `ingest: ${median.toFixed(3)}× calibration (baseline ${BASELINE_RATIO}, ${((ratio - 1) * 100).toFixed(1)}%), ${rounds.map((r) => Math.round(r.wall)).join("/")} msgs/s, calibration ${rounds.map((r) => Math.round(r.calibration)).join("/")}`,
    budgetMs: 0,
    p50: ratio,
    p95: ratio,
    max: ratio,
    iterations: rounds.length,
  });
  expect(median).toBeGreaterThanOrEqual((TOLERANCE * BASELINE_RATIO) / BUDGET_MULTIPLIER);
});
