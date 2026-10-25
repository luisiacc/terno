/**
 * What the filter indexes (v11 unread, v12 quick filters) and the v13 draft
 * column cost ingestion: the same fresh mail into copies of one seeded
 * mailbox, without them and with them, in one process. Each 200-message
 * slice goes into every copy back to back, in a rotating order, so load and
 * core placement hit all of them alike; a round's ratio is its slices' sums,
 * and the cost is the median of the rounds' ratios.
 *
 * A measurement, not a gate (ingest.perf.test.ts is the gate): about 3% when
 * it was written (October 2026), too close to any useful bound to gate on.
 * Opt in: INDEX_COST=1 [INDEX_COST_ROUNDS=30] pnpm test:perf index-cost.
 */
import { generateDataset } from "@terno/mock-data";
import type { IncomingMessage } from "@terno/store";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { openDatabase } from "./index";
import { seedDataset } from "./seed";
import { SqlMailStore } from "./sql-store";
import { report, type Stat } from "./test/perf";

const NOW = Date.UTC(2026, 9, 22, 15, 30);
const ROUNDS = Number(process.env.INDEX_COST_ROUNDS ?? "16");
const V11 = ["threads_unread", "threads_unread_id"];
const V12 = ["threads_attach", "threads_attach_id", "threads_starred_f", "threads_starred_f_id"];

const dir = mkdtempSync(join(tmpdir(), "terno-index-cost-"));
const stats: Stat[] = [];
afterAll(() => {
  if (stats.length) report("index-cost.json", "Ingest cost of the filter indexes (paired A/B)", { rounds: ROUNDS }, stats);
  rmSync(dir, { recursive: true, force: true });
});

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};
/** a distribution-free 95% interval for the median: order statistics of the binomial(n, ½) */
function medianInterval(xs: number[]): [number, number] {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  let k = 0;
  let below = 0.5 ** n;
  let term = 0.5 ** n;
  // the largest k with P(X ≤ k) ≤ 2.5%
  for (;;) {
    term = (term * (n - k)) / (k + 1);
    if (below + term > 0.025 || k + 1 >= n / 2) break;
    below += term;
    k++;
  }
  return [s[k]!, s[n - 1 - k]!];
}

/** the mailbox before v11, at v11, and as shipped (v12's indexes and v13's draft column) */
const VARIANTS: Record<string, string[]> = {
  v10: [...V11, ...V12].map((n) => `DROP INDEX ${n}`).concat("ALTER TABLE drafts DROP COLUMN body_html"),
  v11: V12.map((n) => `DROP INDEX ${n}`).concat("ALTER TABLE drafts DROP COLUMN body_html"),
  v13: [],
};
const PAIRS: [string, string][] = [
  ["v11", "v10"],
  ["v13", "v11"],
  ["v13", "v10"],
];

it.runIf(process.env.INDEX_COST)("measures the filter indexes' ingest cost against the same mailbox without them", { timeout: 3_600_000 }, async () => {
  const source = join(dir, "seed.db");
  const db0 = openDatabase(source);
  const seeded = seedDataset(db0, generateDataset({ threads: 29_500, accounts: 8, seed: 2026, now: NOW, bodyScale: 4 }), { now: NOW });
  db0.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db0.close();
  const names = Object.keys(VARIANTS);
  const stores: Record<string, SqlMailStore> = {};
  for (const k of names) {
    copyFileSync(source, join(dir, `${k}.db`));
    const db = openDatabase(join(dir, `${k}.db`));
    for (const sql of VARIANTS[k]!) db.exec(sql);
    stores[k] = new SqlMailStore(db);
  }
  const ratios: Record<string, number[]> = {};
  let turn = 0;
  // one warm-up round, not counted
  for (let round = -1; round < ROUNDS; round++) {
    const mail: IncomingMessage[] = generateDataset({ threads: 1_000, accounts: 8, seed: 900 + round, now: NOW, bodyScale: 4 }).messages.map((m) => ({
      ...m,
      providerMsgId: `c${round}-${m.providerMsgId}`,
      rfcMessageId: `c${round}-${m.rfcMessageId}`,
      references: m.references.map((r) => `c${round}-${r}`),
      inReplyTo: m.inReplyTo ? `c${round}-${m.inReplyTo}` : null,
      accountId: seeded.accountIds[m.accountIndex]!,
    }));
    const sum: Record<string, { wall: number; cpu: number }> = Object.fromEntries(names.map((k) => [k, { wall: 0, cpu: 0 }]));
    for (let i = 0; i < mail.length; i += 200) {
      const slice = mail.slice(i, i + 200);
      // every order in turn: none of the copies always goes first
      const order = [...names.slice(turn % names.length), ...names.slice(0, turn % names.length)];
      if (Math.floor(turn / names.length) % 2) order.reverse();
      turn++;
      for (const k of order) {
        const t0 = performance.now();
        const cpu0 = process.threadCpuUsage();
        await stores[k]!.sync.ingest(slice, { applyFilters: true, now: NOW, classifier: null });
        const cpu = process.threadCpuUsage(cpu0);
        sum[k]!.wall += performance.now() - t0;
        sum[k]!.cpu += (cpu.user + cpu.system) / 1000;
      }
    }
    if (round < 0) continue;
    for (const [a, b] of PAIRS) for (const m of ["wall", "cpu"] as const) (ratios[`${a} ÷ ${b} ${m}`] ??= []).push(sum[a]![m] / sum[b]![m]);
  }
  for (const k of names) await stores[k]!.close();
  for (const [label, xs] of Object.entries(ratios)) {
    const m = median(xs);
    const [lo, hi] = medianInterval(xs);
    stats.push({
      name: `${label}: ${m.toFixed(4)} (95% ${lo.toFixed(4)}–${hi.toFixed(4)}); ${xs.map((x) => x.toFixed(3)).join(" ")}`,
      budgetMs: 0,
      p50: m,
      p95: hi,
      max: Math.max(...xs),
      iterations: xs.length,
    });
  }
  expect(Object.values(ratios).every((xs) => xs.length === ROUNDS)).toBe(true);
});
