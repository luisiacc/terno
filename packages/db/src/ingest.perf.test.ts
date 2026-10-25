/**
 * Ingestion throughput through the store command, against the same workload
 * before the storage work: 75223cb's ingestMessages (frozen in
 * test/reference-ingest.ts) into a copy of the same mailbox in its schema
 * (v5), with one transaction per slice as Backend.ingestSliced ran it. The
 * two run in this process, each 200-message slice into both back to back in
 * alternating order, so load, core placement and disk contention fall on
 * both alike; a round's ratio is its slices' sums and the gate is the median
 * of the rounds. (It used to divide by a bare SQLite workload: that tracked
 * machine speed, not load, and moved by ±6% from one process to the next.)
 */
import { generateDataset } from "@terno/mock-data";
import type { IncomingMessage } from "@terno/store";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { openDatabase } from "./index";
import { seedDataset } from "./seed";
import { SqlMailStore } from "./sql-store";
import { writeLegacyCopy } from "./test/legacy";
import { BUDGET_MULTIPLIER, report, type Stat } from "./test/perf";
import { Db as ReferenceDb, ingestMessages as referenceIngest } from "./test/reference-ingest";
import { threadCpuMs } from "./test/timing";

const TOLERANCE = 0.97;
/** 75223cb's schema */
const REFERENCE_SCHEMA = 5;
const ROUNDS = 8;

const NOW = Date.UTC(2026, 9, 22, 15, 30);
const dir = mkdtempSync(join(tmpdir(), "terno-ingest-perf-"));
const stats: Stat[] = [];
afterAll(() => {
  report("ingest.json", "Ingestion throughput against 75223cb, paired in-process", { rounds: ROUNDS, tolerance: TOLERANCE }, stats);
  rmSync(dir, { recursive: true, force: true });
});

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

it(`ingests within ${Math.round((1 - TOLERANCE) * 100)}% of the pre-storage-work throughput`, { timeout: 900_000 }, async () => {
  const db = openDatabase(join(dir, "today.db"));
  const seeded = seedDataset(db, generateDataset({ threads: 29_500, accounts: 8, seed: 2026, now: NOW, bodyScale: 4 }), { now: NOW });
  // both mailboxes freshly written, so neither has the other's page layout
  writeLegacyCopy(db, join(dir, "reference.db"), REFERENCE_SCHEMA);
  db.exec("VACUUM");
  const store = new SqlMailStore(db);
  const ref = new ReferenceDb(join(dir, "reference.db"));
  const rounds: { wall: number; cpu: number; today: number; reference: number }[] = [];
  let turn = 0;
  // one warm-up round, not counted
  for (let round = -1; round < ROUNDS; round++) {
    const mail: IncomingMessage[] = generateDataset({ threads: 1_000, accounts: 8, seed: 77 + round, now: NOW, bodyScale: 4 }).messages.map((m) => ({
      ...m,
      providerMsgId: `r${round}-${m.providerMsgId}`,
      rfcMessageId: `r${round}-${m.rfcMessageId}`,
      references: m.references.map((r) => `r${round}-${r}`),
      inReplyTo: m.inReplyTo ? `r${round}-${m.inReplyTo}` : null,
      accountId: seeded.accountIds[m.accountIndex]!,
    }));
    const sum = { today: { wall: 0, cpu: 0 }, reference: { wall: 0, cpu: 0 } };
    const run = async (side: keyof typeof sum, slice: IncomingMessage[]) => {
      const cpu = threadCpuMs();
      const t0 = performance.now();
      // the reference mailbox has no filters: 75223cb's filter pass read an empty table
      if (side === "today") await store.sync.ingest(slice, { applyFilters: true, now: NOW, classifier: null });
      else ref.tx(() => referenceIngest(ref, slice, NOW));
      sum[side].wall += performance.now() - t0;
      sum[side].cpu += threadCpuMs() - cpu;
    };
    for (let i = 0; i < mail.length; i += 200, turn++) {
      const slice = mail.slice(i, i + 200);
      for (const side of turn % 2 ? (["reference", "today"] as const) : (["today", "reference"] as const)) await run(side, slice);
    }
    if (round < 0) continue;
    rounds.push({ wall: sum.reference.wall / sum.today.wall, cpu: sum.reference.cpu / sum.today.cpu, today: mail.length / (sum.today.wall / 1000), reference: mail.length / (sum.reference.wall / 1000) });
  }
  await store.close();
  ref.close();
  const wall = median(rounds.map((r) => r.wall));
  const cpu = median(rounds.map((r) => r.cpu));
  stats.push({
    name: `ingest: ${wall.toFixed(3)}× 75223cb's throughput (CPU ${cpu.toFixed(3)}×); rounds ${rounds.map((r) => r.wall.toFixed(3)).join("/")}; today ${rounds.map((r) => Math.round(r.today)).join("/")} msgs/s, 75223cb ${rounds.map((r) => Math.round(r.reference)).join("/")}`,
    budgetMs: 0,
    p50: wall,
    p95: wall,
    max: wall,
    iterations: rounds.length,
  });
  expect(wall).toBeGreaterThanOrEqual(TOLERANCE / BUDGET_MULTIPLIER);
});
