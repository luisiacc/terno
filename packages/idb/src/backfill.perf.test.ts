/**
 * Plan 65 (Codex R45): the web upgrade's backfill on a mailbox of 1,000,000 messages: every folders.rebuild call, the
 * scan of the messages included, within a frame (a slice looks at a bounded stretch, the scan kept between slices).
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { expect, it } from "vitest";
import { IdbMailStore } from "./store";

const MULT = Number(process.env.PERF_BUDGET_MULTIPLIER ?? "1");
const platform = { uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((resolve) => setImmediate(resolve)) };

it("1,000,000 messages, 1 in 20 labelled: every rebuild slice of the backfill within a frame, every label a membership", { timeout: 600_000 }, async () => {
  const store = await IdbMailStore.open({ factory: new IDBFactory(), name: crypto.randomUUID(), instantSearch: false, platform });
  await store.whenLoaded();
  const c = (store as unknown as { c: { db: { table(name: string): { load(row: Record<string, unknown>): void } } } }).c;
  // the mailbox as loaded (not written: what's measured is the backfill)
  const accounts = await store.accounts.create({ kind: "gmail", email: "synthetic@example.test", displayName: "S", color: "indigo", providerConfig: {}, now: 1 });
  const account = accounts.account.id;
  for (let i = 1; i <= 1_000_000; i++) {
    if (i % 20 === 0) c.db.table("threads").load({ id: i, account_id: account, last_date: i, unread_count: 0, message_count: 1 });
    c.db.table("messages").load({ id: i, account_id: account, thread_id: i, provider_msg_id: `m${i}`, date: i, is_trash: 0, is_spam: 0, gmail_labels: i % 20 === 0 ? JSON.stringify(["INBOX", "Label_1"]) : JSON.stringify(["INBOX"]) });
  }
  // (the shape both the scan and an older id list read)
  (store as unknown as { backfill: unknown }).backfill = { scan: null, done: false, pending: null, ids: null, at: 0 };
  const slices: number[] = [];
  let touched = 0;
  for (let more = true; more; ) {
    const t0 = performance.now();
    const r = await store.folders.rebuild(250);
    slices.push(performance.now() - t0);
    touched += r.touched.length;
    more = r.more;
  }
  slices.sort((a, b) => a - b);
  console.log(`backfill of 1,000,000: ${slices.length} slices, worst ${slices.at(-1)!.toFixed(1)} ms`);
  expect(touched).toBe(50_000);
  expect(slices.at(-1)!).toBeLessThan(16 * MULT);
  await store.close();
});

it("Codex R47: relisting one IMAP folder of 500,000 cached locations: every rebuild slice within a frame", { timeout: 600_000 }, async () => {
  const store = await IdbMailStore.open({ factory: new IDBFactory(), name: crypto.randomUUID(), instantSearch: false, platform });
  await store.whenLoaded();
  const c = (store as unknown as { c: { db: { table(name: string): { load(row: Record<string, unknown>): void } } } }).c;
  const account = (await store.accounts.create({ kind: "imap", email: "synthetic@example.test", displayName: "S", color: "indigo", providerConfig: {}, now: 1 })).account.id;
  // the folder as loaded (not written: what's measured is the rebuild), a thread per 10 messages
  for (let i = 1; i <= 500_000; i++) {
    if (i % 10 === 1) c.db.table("threads").load({ id: i, account_id: account, last_date: i, unread_count: 0, message_count: 10 });
    c.db.table("messages").load({ id: i, account_id: account, thread_id: i - ((i - 1) % 10), provider_msg_id: `m${i}`, date: i, is_trash: 0, is_spam: 0 });
    // in an order no UID sort would keep
    c.db.table("message_locations").load({ message_id: i, account_id: account, mailbox: "Big", uidvalidity: 1, uid: ((i * 7919) % 500_000) + 1, flags: "[]" });
  }
  await store.folders.replace(account, [{ key: "Big", path: ["Big"], selectable: true }]);
  const slices: number[] = [];
  let touched = 0;
  for (let more = true; more; ) {
    const t0 = performance.now();
    const r = await store.folders.rebuild(250);
    slices.push(performance.now() - t0);
    touched += r.touched.length;
    more = r.more;
  }
  slices.sort((a, b) => a - b);
  console.log(`rebuild of 500,000: ${slices.length} slices, worst ${slices.at(-1)!.toFixed(1)} ms`);
  expect(touched).toBe(50_000);
  expect(slices.at(-1)!).toBeLessThan(16 * MULT);
  await store.close();
});
