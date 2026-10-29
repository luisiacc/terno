/**
 * Plan 65 (Codex R34): one conversation of 150,000 messages in a folder, every one expunged at once: its locations go
 * a slice at a time and the thread's membership is decided once, a page of the thread a turn: linear in all, never
 * a frame without a turn.
 */
import { ingest, msg, withAccounts } from "@terno/store/conformance";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openDatabase } from "./index";
import { SqlMailStore, sqlDb } from "./sql-store";
import { BUDGET_MULTIPLIER as MULT } from "./test/perf";
import { stallLessGc, watchGc, watchLoop } from "./test/timing";

it("expunging a 150,000-message conversation: under 1.5 s in all, the longest stall within a frame", { timeout: 1_800_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "terno-expunge-"));
  const store = new SqlMailStore(openDatabase(join(dir, "e.db")), { checkpointWorker: true });
  try {
    const [, m] = await withAccounts(store);
    await store.folders.replace(m!, [{ key: "Big", path: ["Big"], selectable: true }]);
    for (let i = 0; i < 150_000; i += 5000) {
      await ingest(store, Array.from({ length: 5000 }, (_, j) => msg({ accountId: m!, providerMsgId: `m${i + j}`, providerThreadId: "one", locations: [{ mailbox: "Big", uidvalidity: 1, uid: i + j + 1, flags: [] }] })));
    }
    const db = sqlDb(store);
    const ids = db.all<{ id: number }>("SELECT id FROM messages WHERE account_id = ? ORDER BY id", m!).map((r) => r.id);
    expect(new Set(db.all<{ t: number }>("SELECT DISTINCT thread_id AS t FROM messages WHERE account_id = ?", m!).map((r) => r.t)).size).toBe(1);
    expect(db.get<{ c: number }>("SELECT count(*) AS c FROM thread_folders WHERE folder = 'Big'")!.c).toBe(1);
    // load-aware (timing.ts): a busy machine's rare holds count at their CPU time, collections are left out
    const loop = watchLoop(16);
    const gc = watchGc();
    const t0 = performance.now();
    await store.providerStore(m!).locations.removeMany(ids, "Big");
    const total = performance.now() - t0;
    const worst = stallLessGc(loop.stop(), await gc.stop());
    console.log(`expunge 150,000: ${total.toFixed(0)} ms, longest stall ${worst.toFixed(1)} ms`);
    expect(db.get<{ c: number }>("SELECT count(*) AS c FROM thread_folders WHERE folder = 'Big'")!.c).toBe(0);
    expect(total).toBeLessThan(1500 * MULT);
    expect(worst).toBeLessThan(16 * MULT);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("Codex R35: expunging a folder of 50,000 one-message conversations: the longest stall within a frame", { timeout: 1_800_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "terno-expunge-"));
  // checkpoints off the thread, as on desktop (in-thread ones every thousand pages would be the stalls measured)
  const store = new SqlMailStore(openDatabase(join(dir, "e.db")), { checkpointWorker: true });
  try {
    const [, m] = await withAccounts(store);
    await store.folders.replace(m!, [{ key: "Many", path: ["Many"], selectable: true }]);
    for (let i = 0; i < 50_000; i += 5000) {
      await ingest(store, Array.from({ length: 5000 }, (_, j) => msg({ accountId: m!, providerMsgId: `s${i + j}`, providerThreadId: `t${i + j}`, locations: [{ mailbox: "Many", uidvalidity: 1, uid: i + j + 1, flags: [] }] })));
    }
    const db = sqlDb(store);
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
    rmSync(dir, { recursive: true, force: true });
  }
});

it("Codex R37: expunging a 150,000-message conversation while other writes keep coming: the longest stall within a frame", { timeout: 1_800_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "terno-expunge-"));
  const store = new SqlMailStore(openDatabase(join(dir, "e.db")), { checkpointWorker: true });
  try {
    const [, m] = await withAccounts(store);
    await store.folders.replace(m!, [{ key: "Big", path: ["Big"], selectable: true }]);
    for (let i = 0; i < 150_000; i += 5000) {
      await ingest(store, Array.from({ length: 5000 }, (_, j) => msg({ accountId: m!, providerMsgId: `m${i + j}`, providerThreadId: "one", locations: [{ mailbox: "Big", uidvalidity: 1, uid: i + j + 1, flags: [] }] })));
    }
    const db = sqlDb(store);
    const ids = db.all<{ id: number }>("SELECT id FROM messages WHERE account_id = ? ORDER BY id", m!).map((r) => r.id);
    // another account's state written every millisecond: nothing to do with this thread
    const writer = setInterval(() => db.run("UPDATE accounts SET position = position WHERE id <> ?", m!), 1);
    const loop = watchLoop(16);
    const gc = watchGc();
    try {
      await store.providerStore(m!).locations.removeMany(ids, "Big");
    } finally {
      clearInterval(writer);
    }
    const worst = stallLessGc(loop.stop(), await gc.stop());
    console.log(`expunge 150,000 with writes: longest stall ${worst.toFixed(1)} ms`);
    expect(db.get<{ c: number }>("SELECT count(*) AS c FROM thread_folders WHERE folder = 'Big'")!.c).toBe(0);
    expect(worst).toBeLessThan(16 * MULT);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
