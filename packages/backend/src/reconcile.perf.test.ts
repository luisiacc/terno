/**
 * Plan 68 (Codex R53): a folder's messages with no other place, deleted on the server: reconciliation removes them (and
 * recomputes their threads) a batch at a time with turns between, never one transaction for all of them. A batch's
 * bound doesn't follow the rows left alone, and 5,000 orphans are 50 of them, in one transaction three times the stall
 * allowed.
 */
import { openDatabase, sqlDb, SqlMailStore } from "@terno/db";
import { reconcileMessages } from "@terno/mail";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { copyMailbox, LARGE_MAILBOX } from "../../db/src/test/perf-mailbox";
import { stallLessGc, watchGc, watchLoop } from "../../db/src/test/timing";
import { SLICE_MAILBOX } from "./test/slice-mailbox";

const MULT = Number(process.env.PERF_BUDGET_MULTIPLIER ?? "1");
const ORPHANS = 5_000;

it(`reconciling ${ORPHANS} orphans of a deleted folder: the longest stall within the worker's budget`, { timeout: 300_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "terno-reconcile-"));
  copyMailbox(SLICE_MAILBOX, join(dir, "r.db"));
  const store = new SqlMailStore(openDatabase(join(dir, "r.db")), { checkpointWorker: true });
  try {
    const db = sqlDb(store);
    const total = db.get<{ c: number }>("SELECT count(*) AS c FROM messages")!.c;
    const ids = db.all<{ id: number }>("SELECT id FROM messages ORDER BY id LIMIT ?", ORPHANS).map((r) => r.id);
    expect(ids).toHaveLength(ORPHANS);
    const loop = watchLoop(32);
    const gc = watchGc();
    const t0 = performance.now();
    const orphans = await reconcileMessages(ids, {
      of: async () => [],
      providerIds: async (chunk) => new Map(chunk.map((id) => [id, `o${id}`] as const)),
      state: () => ({}) as never,
      updateFlags: async () => {},
      removeMessages: async (chunk) => {
        await store.sync.remove(chunk);
      },
    });
    const took = performance.now() - t0;
    const worst = stallLessGc(loop.stop(), await gc.stop());
    console.log(`reconcile ${ORPHANS} orphans: ${took.toFixed(0)} ms, longest stall ${worst.toFixed(1)} ms`);
    expect(orphans).toHaveLength(ORPHANS);
    expect(db.get("SELECT count(*) AS c FROM messages")).toEqual({ c: total - ORPHANS });
    expect(worst).toBeLessThan(32 * MULT);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("SQL: sparse durable IMAP confirmation among 100,000 messages stays within the worker budget", { timeout: 300_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "terno-flag-reconcile-"));
  const platform = { uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((resolve) => setTimeout(resolve, 0)) };
  const { accountIds } = copyMailbox(LARGE_MAILBOX, join(dir, "flags.db"));
  // the dataset's first IMAP account
  const account = accountIds[2]!;
  const store = new SqlMailStore(openDatabase(join(dir, "flags.db")), { checkpointWorker: true });
  try {
    const db = sqlDb(store);
    expect(db.get<{ kind: string }>("SELECT kind FROM accounts WHERE id = ?", account)!.kind).toBe("imap");
    await store.sync.beginObservation(account, { authoritativeFlags: true });
    const targets = db.all<{ id: number; thread_id: number }>("SELECT max(id) AS id, thread_id FROM messages WHERE account_id = ? AND thread_id % 40 = 1 GROUP BY thread_id HAVING max(is_starred) = 0 AND max(is_draft) = 0 LIMIT 123", account);
    expect(targets).toHaveLength(123);
    // what a confirmation compares: the dataset doesn't place every message
    db.run(`INSERT OR IGNORE INTO message_locations (message_id, account_id, mailbox, uidvalidity, uid, flags) SELECT id, account_id, 'Perf', 7, id, '[]' FROM messages WHERE thread_id IN (${targets.map((t) => t.thread_id).join(",")})`);
    await store.threads.act({ threadIds: targets.map((t) => t.thread_id), action: "star", signal: null, now: 1 });
    const [op] = await store.ops.claimReady(2, 1);
    await store.ops.complete(op!.id, undefined, 3);
    const observation = (await store.sync.beginObservation(account, { authoritativeFlags: true }))!;
    const loop = watchLoop(32), gc = watchGc();
    let afterMessageId = 0, throughMessageId: number | undefined, visited = 0, pages = 0;
    for (;;) {
      const page = await store.providerStore(account).pendingFlagSnapshots({ limit: 50, afterMessageId, throughMessageId });
      throughMessageId ??= page.throughMessageId;
      const updates = [];
      for (const target of page.items) updates.push({ messageId: target.id, expectedProviderMsgId: target.providerMsgId, expectedImapLocations: await store.providerStore(account).locations.of([target.id]), flags: { isStarred: true } });
      await store.sync.updateFlags(account, updates, observation);
      visited += updates.length; pages++;
      await platform.yield();
      if (!page.hasMore) break;
      afterMessageId = page.items[page.items.length - 1]!.id;
    }
    const worst = stallLessGc(loop.stop(), await gc.stop());
    console.log(`SQL sparse IMAP flags: ${visited} targets/${pages} pages, longest stall ${worst.toFixed(1)} ms`);
    expect(visited).toBe(123); expect(pages).toBe(3);
    expect((await store.providerStore(account).pendingFlagSnapshots({ limit: 50 })).items).toEqual([]);
    expect(worst).toBeLessThan(32 * MULT);
  } finally { await store.close(); rmSync(dir, { recursive: true, force: true }); }
});
