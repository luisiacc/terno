import "fake-indexeddb/auto";
import { expect, it } from "vitest";
import { IdbMailStore } from "./store";

it("idle IMAP pending lookups stay below 5 ms over 50,000 completed IndexedDB rows", async () => {
  const store = await IdbMailStore.open({ name: "capture-pending-perf-50k", factory: indexedDB, instantSearch: false, platform: { uuid: () => crypto.randomUUID(), yield: () => Promise.resolve() } });
  try {
    await store.whenLoaded();
    const { account } = await store.accounts.create({ kind: "imap", email: "pending@example.test", displayName: "P", color: "brown", now: 0 });
    // 50,000 complete messages in the mirror (SQLite's test writes the same in SQL): nothing to capture among them
    const db = (store as unknown as { db: { table(n: string): { load(row: Record<string, unknown>): void } } }).db;
    for (let i = 1; i <= 50_000; i++) {
      db.table("messages").load({ id: i, account_id: account.id, thread_id: 1, provider_msg_id: `complete:${i}`, date: i, body_state: "full", attachments_captured: 1, attachment_pending: 0, is_trash: 0, is_spam: 0 });
      db.table("message_locations").load({ message_id: i, account_id: account.id, mailbox: "INBOX", uidvalidity: 1, uid: i, flags: "[]" });
    }
    const times: number[] = [];
    const provider = store.providerStore(account.id);
    for (let i = 0; i < 100; i++) {
      const start = performance.now();
      expect(await provider.pendingBodies(50)).toEqual([]);
      expect(await provider.countPendingBodies()).toBe(0);
      times.push(performance.now() - start);
    }
    const p95 = times.sort((a,b) => a - b)[94]!;
    expect(p95).toBeLessThanOrEqual(5);
    (globalThis as { process?: { stderr: { write(text: string): void } } }).process?.stderr.write(`[50k IDB IMAP pending] p95 ${p95.toFixed(3)} ms\n`);
  } finally { await store.close(); }
});
