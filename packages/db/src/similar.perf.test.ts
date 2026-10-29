/**
 * Plan 63: what the "… similar" snackbar and submenu read, at ~50k messages:
 * the offers for the busiest sender (and its domain), counted with early
 * stops, a scope with nothing left in place, and the resolve of a whole scope.
 */
import { generateDataset } from "@terno/mock-data";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { openDatabase } from "./index";
import { SqlMailStore } from "./sql-store";
import { BUDGET_MULTIPLIER, measureAsync, report, type Stat } from "./test/perf";

const NOW = Date.UTC(2026, 9, 22, 15, 30);
let store: SqlMailStore;
let dir: string;
const stats: Stat[] = [];
const meta: Record<string, unknown> = {};
let busiest: { email: string; threadId: number };

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "terno-similar-perf-"));
  store = new SqlMailStore(openDatabase(join(dir, "perf.db")));
  const seeded = await store.dev.seed(generateDataset({ threads: 29_500, accounts: 8, seed: 2026, now: NOW, bodyScale: 4 }), { now: NOW });
  meta.messages = seeded.messageCount;
  expect(seeded.messageCount).toBeGreaterThanOrEqual(50_000);
  const db = store.db;
  busiest = db.get<{ email: string; threadId: number }>(
    "SELECT from_email AS email, max(thread_id) AS threadId FROM messages WHERE is_sent = 0 GROUP BY from_email ORDER BY count(*) DESC LIMIT 1",
  )!;
  meta.busiestMessages = db.get<{ c: number }>("SELECT count(*) AS c FROM messages WHERE from_email = ?", busiest.email)!.c;
});

afterAll(async () => {
  report("similar.json", "similar mail (plan 63, SqlMailStore)", meta, stats);
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function gate(name: string, budgetMs: number, fn: (i: number) => Promise<unknown>) {
  const s = await measureAsync(name, budgetMs, fn);
  stats.push(s);
  expect(s.p95, `${name} p95 ${s.p95.toFixed(2)}ms > ${budgetMs}ms`).toBeLessThanOrEqual(budgetMs * BUDGET_MULTIPLIER);
}

it("offers for the busiest sender (all four scopes, capped counts) within a frame, for every action", async () => {
  expect(meta.busiestMessages as number).toBeGreaterThan(1000);
  for (const action of ["archive", "trash", "spam"] as const) {
    await gate(`offers ${action}`, 16, () => store.similar.offers([busiest.threadId], action));
  }
});

it("a scope with nothing left in place, and a whole scope resolved for the sweep", async () => {
  await gate("resolve sender (spam)", 30, () => store.similar.resolve({ kind: "sender", email: busiest.email }, "spam", []));
  store.db.run("UPDATE threads SET in_inbox = 0");
  await gate("offers, nothing in the inbox", 16, () => store.similar.offers([busiest.threadId], "archive"));
});
