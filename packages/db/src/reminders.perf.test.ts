/**
 * Plan 87 at ~50k messages: 1,000 reminders (the cap), all "noReply", on
 * the longest conversations: the list, a backend slice of the answered
 * check, and the summaries the Inbox's top and the Reminders list read.
 */
import { REMINDERS_MAX } from "@terno/core";
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

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "terno-reminders-perf-"));
  store = new SqlMailStore(openDatabase(join(dir, "perf.db")));
  const seeded = await store.dev.seed(generateDataset({ threads: 29_500, accounts: 8, seed: 2026, now: NOW, bodyScale: 2 }), { now: NOW });
  meta.messages = seeded.messageCount;
  expect(seeded.messageCount).toBeGreaterThanOrEqual(50_000);
  const ids = store.db.all<{ id: number }>("SELECT id FROM threads ORDER BY message_count DESC, id LIMIT ?", REMINDERS_MAX).map((r) => r.id);
  // set before every message: each one's answered check reads the whole conversation
  const r = await store.reminders.put(ids.map((threadId) => ({ threadId, dueAt: NOW + 86_400_000, kind: "noReply" as const, setAt: 0 })), REMINDERS_MAX);
  expect(r.ok).toBe(true);
  meta.longest = store.db.get<{ c: number }>("SELECT max(message_count) AS c FROM threads")!.c;
}, 600_000);

afterAll(async () => {
  report("reminders.json", "reminders (plan 87, SqlMailStore)", meta, stats);
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function gate(name: string, budgetMs: number, fn: (i: number) => Promise<unknown>) {
  const s = await measureAsync(name, budgetMs, fn, 30);
  stats.push(s);
  expect(s.p95, `${name} p95 ${s.p95.toFixed(2)}ms > ${budgetMs}ms`).toBeLessThanOrEqual(budgetMs * BUDGET_MULTIPLIER);
}

it("the list, a slice of the answered check and the 1,000 summaries each within a frame", async () => {
  const list = await store.reminders.list();
  expect(list).toHaveLength(REMINDERS_MAX);
  await gate("list", 16, () => store.reminders.list());
  // the backend's first slice (BULK_SLICE's initial size); answered, since every reminder predates its mail
  await gate("answered, 64", 8, () => store.reminders.answered(list.slice(0, 64)));
  await gate("summaries", 16, () => store.threads.summaries(list.map((r) => r.threadId)));
});
