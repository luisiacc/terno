/**
 * Plan 68 (Codex R34): one conversation of 150,000 messages in a folder, every one expunged at once: its locations go
 * a slice at a time and the thread's membership is decided once, a page of the thread a turn: linear in all, never
 * a frame without a turn. The conversation's size stays: a slice that read the whole thread would grow with it. It's
 * written in SQL, not by ingest (minutes), and copied for the second case.
 */
import { withAccounts } from "@terno/store/conformance";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { openDatabase } from "./index";
import { SqlMailStore, sqlDb } from "./sql-store";
import type { Db } from "./sqlite";
import { BUDGET_MULTIPLIER as MULT } from "./test/perf";
import { stallLessGc, watchGc, watchLoop } from "./test/timing";

const dir = mkdtempSync(join(tmpdir(), "terno-expunge-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** `n` messages of the account, in `threads` conversations, all in the folder `key` (locations and memberships as the store keeps them) */
function fill(db: Db, accountId: number, key: string, n: number, threads: number): void {
  db.exec("PRAGMA foreign_keys = OFF");
  db.tx(() => {
    db.run(`WITH RECURSIVE t(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM t WHERE x < ?) INSERT INTO threads (account_id, provider_thread_id, last_date, message_count) SELECT ?, 't' || x, 1000, ? FROM t`, threads, accountId, Math.ceil(n / threads));
    const first = db.get<{ id: number }>("SELECT min(id) AS id FROM threads WHERE account_id = ? AND provider_thread_id LIKE 't%'", accountId)!.id;
    db.run(
      `WITH RECURSIVE m(x) AS (VALUES(0) UNION ALL SELECT x + 1 FROM m WHERE x < ? - 1)
       INSERT INTO messages (account_id, thread_id, provider_msg_id, date, from_email, subject) SELECT ?, ? + (x % ?), 'm' || x, 1000 + x, 'ana@example.com', 'Asunto' FROM m`,
      n, accountId, first, threads,
    );
    db.run("INSERT INTO message_locations (message_id, account_id, mailbox, uidvalidity, uid, flags) SELECT id, account_id, ?, 1, id, '[]' FROM messages WHERE account_id = ?", key, accountId);
    db.run("INSERT INTO thread_folders (thread_id, account_id, folder, last_date, unread) SELECT id, account_id, ?, last_date, 0 FROM threads WHERE account_id = ? AND provider_thread_id LIKE 't%'", key, accountId);
  });
  db.exec("PRAGMA foreign_keys = ON");
}

const bigPath = join(dir, "big.db");
let account = 0;
beforeAll(async () => {
  const store = new SqlMailStore(openDatabase(bigPath));
  const [, m] = await withAccounts(store);
  account = m!;
  await store.folders.replace(m!, [{ key: "Big", path: ["Big"], selectable: true }]);
  const db = sqlDb(store);
  fill(db, m!, "Big", 150_000, 1);
  expect(db.get<{ c: number }>("SELECT count(*) AS c FROM thread_folders WHERE folder = 'Big'")!.c).toBe(1);
  await store.close();
}, 300_000);

/** a copy of the 150,000-message conversation, with checkpoints off the thread, as on desktop (in-thread ones every thousand pages would be the stalls measured) */
function bigCopy(name: string): SqlMailStore {
  const path = join(dir, name);
  copyFileSync(bigPath, path);
  return new SqlMailStore(openDatabase(path), { checkpointWorker: true });
}

it("expunging a 150,000-message conversation: under 1.5 s in all, the longest stall within a frame", { timeout: 300_000 }, async () => {
  const store = bigCopy("e1.db");
  try {
    const db = sqlDb(store);
    const ids = db.all<{ id: number }>("SELECT id FROM messages WHERE account_id = ? ORDER BY id", account).map((r) => r.id);
    // load-aware (timing.ts): a busy machine's rare holds count at their CPU time, collections are left out
    const loop = watchLoop(16);
    const gc = watchGc();
    const t0 = performance.now();
    await store.providerStore(account).locations.removeMany(ids, "Big");
    const total = performance.now() - t0;
    const worst = stallLessGc(loop.stop(), await gc.stop());
    console.log(`expunge 150,000: ${total.toFixed(0)} ms, longest stall ${worst.toFixed(1)} ms`);
    expect(db.get<{ c: number }>("SELECT count(*) AS c FROM thread_folders WHERE folder = 'Big'")!.c).toBe(0);
    expect(total).toBeLessThan(1500 * MULT);
    expect(worst).toBeLessThan(16 * MULT);
  } finally {
    await store.close();
  }
});

it("Codex R37: expunging a 150,000-message conversation while other writes keep coming: the longest stall within a frame", { timeout: 300_000 }, async () => {
  const store = bigCopy("e2.db");
  try {
    const db = sqlDb(store);
    const ids = db.all<{ id: number }>("SELECT id FROM messages WHERE account_id = ? ORDER BY id", account).map((r) => r.id);
    // another account's state written every millisecond: nothing to do with this thread
    const writer = setInterval(() => db.run("UPDATE accounts SET position = position WHERE id <> ?", account), 1);
    const loop = watchLoop(16);
    const gc = watchGc();
    try {
      await store.providerStore(account).locations.removeMany(ids, "Big");
    } finally {
      clearInterval(writer);
    }
    const worst = stallLessGc(loop.stop(), await gc.stop());
    console.log(`expunge 150,000 with writes: longest stall ${worst.toFixed(1)} ms`);
    expect(db.get<{ c: number }>("SELECT count(*) AS c FROM thread_folders WHERE folder = 'Big'")!.c).toBe(0);
    expect(worst).toBeLessThan(16 * MULT);
  } finally {
    await store.close();
  }
});

it("Codex R35: expunging a folder of 50,000 one-message conversations: the longest stall within a frame", { timeout: 300_000 }, async () => {
  const store = new SqlMailStore(openDatabase(join(dir, "many.db")), { checkpointWorker: true });
  try {
    const [, m] = await withAccounts(store);
    await store.folders.replace(m!, [{ key: "Many", path: ["Many"], selectable: true }]);
    const db = sqlDb(store);
    fill(db, m!, "Many", 50_000, 50_000);
    const ids = db.all<{ id: number }>("SELECT id FROM messages WHERE account_id = ? ORDER BY id", m!).map((r) => r.id);
    expect(db.get<{ c: number }>("SELECT count(*) AS c FROM thread_folders WHERE folder = 'Many'")!.c).toBe(50_000);
    const loop = watchLoop(16);
    const gc = watchGc();
    const t0 = performance.now();
    await store.providerStore(m!).locations.removeMany(ids, "Many");
    const total = performance.now() - t0;
    const worst = stallLessGc(loop.stop(), await gc.stop());
    console.log(`expunge 50,000 short conversations: ${total.toFixed(0)} ms, longest stall ${worst.toFixed(1)} ms`);
    expect(db.get<{ c: number }>("SELECT count(*) AS c FROM thread_folders WHERE folder = 'Many'")!.c).toBe(0);
    expect(worst).toBeLessThan(16 * MULT);
  } finally {
    await store.close();
  }
});
