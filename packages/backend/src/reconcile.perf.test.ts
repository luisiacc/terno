/**
 * Plan 68 (Codex R53): a folder of 50,000 messages with no other place, deleted on the server: reconciliation removes
 * them (and recomputes their threads) a batch at a time with turns between, never one transaction for all of them.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { IdbMailStore } from "@terno/idb";
import type { MailStore } from "@terno/store";
import { openDatabase, SqlMailStore } from "@terno/db";
import { reconcileMessages } from "@terno/mail";
import { ingest, msg, withAccounts } from "@terno/store/conformance";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { stallLessGc, watchGc, watchLoop } from "../../db/src/test/timing";

const MULT = Number(process.env.PERF_BUDGET_MULTIPLIER ?? "1");

it("reconciling 50,000 orphans of a deleted folder: the longest stall within the worker's budget", { timeout: 1_800_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "terno-reconcile-"));
  const store = new SqlMailStore(openDatabase(join(dir, "r.db")), { checkpointWorker: true });
  try {
    const [, m] = await withAccounts(store);
    for (let i = 0; i < 50_000; i += 5000) await ingest(store, Array.from({ length: 5000 }, (_, j) => msg({ accountId: m!, providerMsgId: `o${i + j}`, providerThreadId: `t${i + j}` })));
    const ids = (await store.debug.snapshot()).messages.filter((x) => x.accountId === m).map((x) => x.id);
    expect(ids).toHaveLength(50_000);
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
    const total = performance.now() - t0;
    const worst = stallLessGc(loop.stop(), await gc.stop());
    console.log(`reconcile 50,000 orphans: ${total.toFixed(0)} ms, longest stall ${worst.toFixed(1)} ms`);
    expect(orphans).toHaveLength(50_000);
    expect((await store.debug.snapshot()).messages.filter((x) => x.accountId === m)).toHaveLength(0);
    expect(worst).toBeLessThan(32 * MULT);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const kind of ["SQL", "IDB"] as const) it(`${kind}: sparse durable IMAP confirmation in 50,000 messages stays within the worker budget`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "terno-flag-reconcile-"));
  const platform = { uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((resolve) => setImmediate(resolve)) };
  const store: MailStore = kind === "SQL"
    ? new SqlMailStore(openDatabase(join(dir, "flags.db")), { checkpointWorker: true })
    : await IdbMailStore.open({ name: "synthetic-flag-perf", factory: new IDBFactory(), platform, instantSearch: false });
  try {
    const [, account] = await withAccounts(store);
    for (let i = 0; i < 50_000; i += 1000) await ingest(store, Array.from({ length: 1000 }, (_, j) => msg({ accountId: account!, providerMsgId: `f${i + j}`, providerThreadId: `t${i + j}`, locations: [{ mailbox: "INBOX", uidvalidity: 7, uid: i + j + 1, flags: [] }] })));
    await store.sync.beginObservation(account!, { authoritativeFlags: true });
    const targets = (await store.debug.snapshot()).messages.filter((message) => message.id % 400 === 1).slice(0, 123);
    expect(targets).toHaveLength(123);
    await store.threads.act({ threadIds: targets.map((message) => message.threadId), action: "star", signal: null, now: 1 });
    const [op] = await store.ops.claimReady(2, 1);
    await store.ops.complete(op!.id, undefined, 3);
    const observation = (await store.sync.beginObservation(account!, { authoritativeFlags: true }))!;
    const loop = watchLoop(32), gc = watchGc();
    let afterMessageId = 0, throughMessageId: number | undefined, visited = 0, pages = 0;
    for (;;) {
      const page = await store.providerStore(account!).pendingFlagSnapshots({ limit: 50, afterMessageId, throughMessageId });
      throughMessageId ??= page.throughMessageId;
      const updates = [];
      for (const target of page.items) updates.push({ messageId: target.id, expectedProviderMsgId: target.providerMsgId, expectedImapLocations: await store.providerStore(account!).locations.of([target.id]), flags: { isStarred: true } });
      await store.sync.updateFlags(account!, updates, observation);
      visited += updates.length; pages++;
      await platform.yield();
      if (!page.hasMore) break;
      afterMessageId = page.items[page.items.length - 1]!.id;
    }
    const worst = stallLessGc(loop.stop(), await gc.stop());
    console.log(`${kind} sparse IMAP flags: ${visited} targets/${pages} pages in 50,000, longest stall ${worst.toFixed(1)} ms`);
    expect(visited).toBe(123); expect(pages).toBe(3);
    expect((await store.providerStore(account!).pendingFlagSnapshots({ limit: 50 })).items).toEqual([]);
    expect(worst).toBeLessThan(32 * MULT);
  } finally { await store.close(); rmSync(dir, { recursive: true, force: true }); }
});
