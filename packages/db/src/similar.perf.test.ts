/**
 * Plan 63: what the "… similar" snackbar and submenu read, at ~50k messages:
 * the offers for the busiest sender, then for one sender that sent all of it
 * (dominant, a rare subject, nothing in place), and a sweep's resolve pages.
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

it("one sender sent everything: offers stay within a frame (dominant, rare subject, nothing in place), a sweep's pages within a slice", async () => {
  // every received message from one sender and one domain: each scope is the whole mailbox
  store.db.run("UPDATE messages SET from_email = 'bot@notify.example', from_domain = 'notify.example', list_id = 'all.notify.example' WHERE is_sent = 0");
  meta.dominantMessages = store.db.get<{ c: number }>("SELECT count(*) AS c FROM messages WHERE from_email = 'bot@notify.example'")!.c;
  expect(meta.dominantMessages as number).toBeGreaterThan(40_000);
  for (const action of ["archive", "spam"] as const) await gate(`offers dominant ${action}`, 16, () => store.similar.offers([busiest.threadId], action));
  const rare = { kind: "subject", email: "bot@notify.example", subject: "nothing has this subject" } as const;
  await gate("resolve page, rare subject", 8, () => store.similar.resolvePage(rare, "spam", [], null, 2000));
  await gate("resolve page, dominant sender", 8, () => store.similar.resolvePage({ kind: "sender", email: "bot@notify.example" }, "spam", [], null, 2000));
  // every page of the whole sweep, the last ones too: each seeks its cursor, none rereads what came before
  const pages: number[] = [];
  for (let cursor: number | null = null; ; ) {
    const started = performance.now();
    const p = await store.similar.resolvePage({ kind: "sender", email: "bot@notify.example" }, "spam", [], cursor, 2000);
    pages.push(performance.now() - started);
    if (p.next === null) break;
    cursor = p.next;
  }
  meta.sweepPages = pages.length;
  expect(pages.length).toBeGreaterThan(15);
  const late = pages.slice(-5);
  expect(Math.max(...late), `late pages ${late.map((ms) => ms.toFixed(2)).join(", ")}`).toBeLessThanOrEqual(8 * BUDGET_MULTIPLIER);
  store.db.run("UPDATE threads SET in_inbox = 0");
  await gate("offers dominant, nothing in the inbox", 16, () => store.similar.offers([busiest.threadId], "archive"));
});
