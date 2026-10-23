/**
 * Ingestion throughput through the store command, against the throughput of
 * the same workload before the storage work (75223cb: one transaction per
 * slice with ingestMessages and the filter pass, as Backend.ingestSliced ran
 * it), recorded on the reference machine. Best of three rounds of fresh mail
 * on a 51k-message mailbox; CPU time is reported alongside.
 */
import { generateDataset } from "@unica/mock-data";
import type { IncomingMessage } from "@unica/store";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { openDatabase } from "./index";
import { seedDataset } from "./seed";
import { SqlMailStore } from "./sql-store";
import { BUDGET_MULTIPLIER, report, type Stat } from "./test/perf";

/** msgs/s at 75223cb, median of best-of-three over 20 runs of this workload (M-series reference machine) */
const BASELINE_MSGS_PER_SECOND = 2900;
const TOLERANCE = 0.97;

const NOW = Date.UTC(2026, 9, 22, 15, 30);
const dir = mkdtempSync(join(tmpdir(), "unica-ingest-perf-"));
const stats: Stat[] = [];
afterAll(() => {
  report("ingest.json", "Ingestion throughput", { baselineMsgsPerSecond: BASELINE_MSGS_PER_SECOND }, stats);
  rmSync(dir, { recursive: true, force: true });
});

it(`ingests within ${Math.round((1 - TOLERANCE) * 100)}% of the pre-storage-work throughput`, async () => {
  const db = openDatabase(join(dir, "i.db"));
  const store = new SqlMailStore(db);
  const seeded = seedDataset(db, generateDataset({ threads: 29_500, accounts: 8, seed: 2026, now: NOW, bodyScale: 4 }), { now: NOW });
  const rounds: { wall: number; cpu: number }[] = [];
  for (let round = 0; round < 3; round++) {
    const mail: IncomingMessage[] = generateDataset({ threads: 2_000, accounts: 8, seed: 77 + round, now: NOW, bodyScale: 4 }).messages.map((m) => ({
      ...m,
      providerMsgId: `r${round}-${m.providerMsgId}`,
      rfcMessageId: `r${round}-${m.rfcMessageId}`,
      references: m.references.map((r) => `r${round}-${r}`),
      inReplyTo: m.inReplyTo ? `r${round}-${m.inReplyTo}` : null,
      accountId: seeded.accountIds[m.accountIndex]!,
    }));
    const t0 = performance.now();
    const cpu0 = process.cpuUsage();
    for (let i = 0; i < mail.length; i += 200) await store.sync.ingest(mail.slice(i, i + 200), { applyFilters: true, now: NOW, classifier: null });
    const cpu = process.cpuUsage(cpu0);
    rounds.push({ wall: mail.length / ((performance.now() - t0) / 1000), cpu: mail.length / ((cpu.user + cpu.system) / 1e6) });
  }
  await store.close();
  const best = Math.max(...rounds.map((r) => r.wall));
  const ratio = best / BASELINE_MSGS_PER_SECOND;
  stats.push({
    name: `ingest: ${Math.round(best)} msgs/s (baseline ${BASELINE_MSGS_PER_SECOND}, ${((ratio - 1) * 100).toFixed(1)}%), rounds ${rounds.map((r) => Math.round(r.wall)).join("/")}, CPU ${rounds.map((r) => Math.round(r.cpu)).join("/")} msgs/CPU-s`,
    budgetMs: 0,
    p50: ratio,
    p95: ratio,
    max: ratio,
    iterations: rounds.length,
  });
  expect(best).toBeGreaterThanOrEqual((TOLERANCE * BASELINE_MSGS_PER_SECOND) / BUDGET_MULTIPLIER);
}, 600_000);
