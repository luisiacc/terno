import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { IdbMailStore } from "./index";
import { ingest, msg, withAccounts } from "@terno/store/conformance";
import { expect, it } from "vitest";
import { stallLessGc, watchGc, watchLoop } from "../../db/src/test/timing";
const MULT = Number(process.env.PERF_BUDGET_MULTIPLIER ?? "1");

it("IDB: sparse durable IMAP confirmation in 50,000 messages stays within the worker budget", async () => {
  const kind = "IDB";
  const platform = { uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((resolve) => setTimeout(resolve, 0)) };
  const store = await IdbMailStore.open({ name: "synthetic-flag-perf", factory: new IDBFactory(), platform, instantSearch: false });
  try {
    const [, account] = await withAccounts(store);
    await store.whenLoaded();
    // 123 messages through ingest, 399 others loaded into the mirror between each: the sparse ones are real, what's in their way is rows
    const db = (store as unknown as { db: { table(n: string): { highestKey(): number; load(row: Record<string, unknown>): void } } }).db;
    const targets: { threadId: number }[] = [];
    for (let n = 0; n < 124; n++) {
      await ingest(store, [msg({ accountId: account!, providerMsgId: `f${n}`, providerThreadId: `t${n}`, locations: [{ mailbox: "INBOX", uidvalidity: 7, uid: n * 400 + 1, flags: [] }] })]);
      const top = db.table("messages").highestKey();
      if (n < 123) targets.push({ threadId: db.table("threads").highestKey() });
      for (let i = 1; i < 400; i++) {
        db.table("messages").load({ id: top + i, account_id: account, thread_id: 1_000_000, provider_msg_id: `f${n}-${i}`, date: 0, is_trash: 0, is_spam: 0 });
        db.table("message_locations").load({ message_id: top + i, account_id: account, mailbox: "INBOX", uidvalidity: 7, uid: n * 400 + 1 + i, flags: "[]" });
      }
    }
    await store.sync.beginObservation(account!, { authoritativeFlags: true });
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
  } finally { await store.close(); }
});
