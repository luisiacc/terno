/**
 * Plan 65 (Codex R45): the web upgrade's backfill on a mailbox of 1,000,000 messages: every folders.rebuild call, the
 * scan of the messages included, within a frame (a slice looks at a bounded stretch, the scan kept between slices).
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { expect, it } from "vitest";
import { sampleAsync, settle } from "../../db/src/test/timing";
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

it("Codex R48: expunging a 500,000-message conversation: the longest stall within a frame", { timeout: 1_200_000 }, async () => {
  const { stallLessGc, watchGc, watchLoop } = await import("../../db/src/test/timing");
  const store = await IdbMailStore.open({ factory: new IDBFactory(), name: crypto.randomUUID(), instantSearch: false, platform });
  await store.whenLoaded();
  const c = (store as unknown as { c: { db: { table(name: string): { load(row: Record<string, unknown>): void } } } }).c;
  const account = (await store.accounts.create({ kind: "imap", email: "synthetic@example.test", displayName: "S", color: "indigo", providerConfig: {}, now: 1 })).account.id;
  await store.folders.replace(account, [{ key: "Big", path: ["Big"], selectable: true }]);
  c.db.table("threads").load({ id: 1, account_id: account, last_date: 1, unread_count: 0, message_count: 500_000 });
  c.db.table("thread_folders").load({ thread_id: 1, account_id: account, folder: "Big", last_date: 1, unread: 0 });
  const ids: number[] = [];
  for (let i = 1; i <= 500_000; i++) {
    c.db.table("messages").load({ id: i, account_id: account, thread_id: 1, provider_msg_id: `m${i}`, date: i, is_trash: 0, is_spam: 0 });
    c.db.table("message_locations").load({ message_id: i, account_id: account, mailbox: "Big", uidvalidity: 1, uid: i, flags: "[]" });
    ids.push(i);
  }
  const loop = watchLoop(16);
  const gc = watchGc();
  const t0 = performance.now();
  await store.providerStore(account).locations.removeMany(ids, "Big");
  const total = performance.now() - t0;
  const worst = stallLessGc(loop.stop(), await gc.stop());
  console.log(`expunge 500,000 (IndexedDB): ${total.toFixed(0)} ms, longest stall ${worst.toFixed(1)} ms`);
  expect((await store.threads.list({ view: "all", accountId: account, folder: "Big", limit: 10 })).items).toHaveLength(0);
  expect(worst).toBeLessThan(16 * MULT);
  await store.close();
});

it("Codex R48: a folder of 150,000 threads opened cold, and read again after an arrival, within a frame", { timeout: 1_200_000 }, async () => {
  const store = await IdbMailStore.open({ factory: new IDBFactory(), name: crypto.randomUUID(), instantSearch: false, platform });
  await store.whenLoaded();
  const c = (store as unknown as { c: { db: { tx<T>(fn: () => T): T; table(name: string): { load(row: Record<string, unknown>): void; put(row: Record<string, unknown>): unknown } } } }).c;
  const account = (await store.accounts.create({ kind: "gmail", email: "synthetic@example.test", displayName: "S", color: "indigo", providerConfig: {}, now: 1 })).account.id;
  await store.folders.replace(account, [{ key: "Label_big", path: ["Big"], selectable: true }]);
  for (let i = 1; i <= 150_000; i++) {
    // dates in no order: nothing kept sorted to start from
    const date = 1_700_000_000_000 + ((i * 7919) % 150_000) * 1000;
    c.db.table("threads").load({ id: i, account_id: account, last_date: date, unread_count: 0, message_count: 1, in_inbox: 0, in_trash: 0, in_spam: 0 });
    c.db.table("thread_folders").load({ thread_id: i, account_id: account, folder: "Label_big", last_date: date, unread: 0 });
  }
  const page = { view: "all" as const, accountId: account, folder: "Label_big", limit: 100 };
  // load-aware (timing.ts): on a busy machine a sample the OS held counts at its CPU time
  const firstSample = await sampleAsync(() => store.threads.list(page));
  const first = firstSample.result;
  const cold = settle([firstSample]).ms[0]!;
  expect(first.items).toHaveLength(100);
  // pages while the order is built, then once it's kept
  const reads: number[] = [];
  let cursor = first.nextCursor;
  for (let i = 0; i < 30 && cursor; i++) {
    const at = cursor;
    const sample = await sampleAsync(() => store.threads.list({ ...page, cursor: at }));
    reads.push(settle([sample]).ms[0]!);
    cursor = sample.result.nextCursor;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  // an arrival: one more member, newest
  c.db.table("threads").load({ id: 150_001, account_id: account, last_date: 1_900_000_000_000, unread_count: 0, message_count: 1, in_inbox: 0, in_trash: 0, in_spam: 0 });
  c.db.tx(() => c.db.table("thread_folders").put({ thread_id: 150_001, account_id: account, folder: "Label_big", last_date: 1_900_000_000_000, unread: 0 }));
  const afterSample = await sampleAsync(() => store.threads.list(page));
  const after = afterSample.result;
  const arrival = settle([afterSample]).ms[0]!;
  console.log(`folder of 150,000: cold first page ${cold.toFixed(1)} ms, pages while built ${Math.max(...reads).toFixed(1)} ms, after an arrival ${arrival.toFixed(2)} ms`);
  expect(after.items[0]!.id).toBe(150_001);
  // the backend worker's stall budget (two frames, plan 17), where these reads run: the old sort was 44 ms cold
  expect(cold).toBeLessThan(32 * MULT);
  expect(Math.max(...reads)).toBeLessThan(32 * MULT);
  expect(arrival).toBeLessThan(2 * MULT);
  await store.close();
});

it("Codex R49: Unread in a folder of 150,000 unread threads, cold and after many changes, within a frame", { timeout: 1_200_000 }, async () => {
  const store = await IdbMailStore.open({ factory: new IDBFactory(), name: crypto.randomUUID(), instantSearch: false, platform });
  await store.whenLoaded();
  const c = (store as unknown as { c: { db: { tx<T>(fn: () => T): T; table(name: string): { load(row: Record<string, unknown>): void; put(row: Record<string, unknown>): unknown; get(...k: unknown[]): Record<string, unknown> | undefined } } } }).c;
  const account = (await store.accounts.create({ kind: "gmail", email: "synthetic@example.test", displayName: "S", color: "indigo", providerConfig: {}, now: 1 })).account.id;
  await store.folders.replace(account, [{ key: "Label_big", path: ["Big"], selectable: true }]);
  for (let i = 1; i <= 150_000; i++) {
    const date = 1_700_000_000_000 + ((i * 7919) % 150_000) * 1000;
    c.db.table("threads").load({ id: i, account_id: account, last_date: date, unread_count: 1, message_count: 1, in_inbox: 0, in_trash: 0, in_spam: 0 });
    c.db.table("thread_folders").load({ thread_id: i, account_id: account, folder: "Label_big", last_date: date, unread: 1 });
  }
  const page = { view: "all" as const, accountId: account, folder: "Label_big", filter: "unread" as const, limit: 100 };
  const coldSample = await sampleAsync(() => store.threads.list(page));
  expect(coldSample.result.items).toHaveLength(100);
  const cold = settle([coldSample]).ms[0]!;
  // let the order be built, then 100 read: more than the kept order places by search, so it's built again
  await new Promise((resolve) => setTimeout(resolve, 2000));
  c.db.tx(() => {
    for (let i = 1; i <= 100; i++) {
      c.db.table("threads").put({ ...c.db.table("threads").get(i)!, unread_count: 0 });
      c.db.table("thread_folders").put({ ...c.db.table("thread_folders").get(i, "Label_big")!, unread: 0 });
    }
  });
  const afterSample = await sampleAsync(() => store.threads.list(page));
  expect(afterSample.result.items).toHaveLength(100);
  const after = settle([afterSample]).ms[0]!;
  console.log(`Unread in a folder of 150,000: cold ${cold.toFixed(1)} ms, after 100 changes ${after.toFixed(1)} ms`);
  // the backend worker's stall budget (two frames, plan 17): the old sort was 42 ms cold, 57 after the changes
  expect(cold).toBeLessThan(32 * MULT);
  expect(after).toBeLessThan(32 * MULT);
  await store.close();
});

it("Codex R49: a Message-ID twin lookup among 150,000 sharing it, cold and after a write, within a frame", { timeout: 1_200_000 }, async () => {
  const store = await IdbMailStore.open({ factory: new IDBFactory(), name: crypto.randomUUID(), instantSearch: false, platform });
  await store.whenLoaded();
  const c = (store as unknown as { c: { db: { tx<T>(fn: () => T): T; table(name: string): { load(row: Record<string, unknown>): void; put(row: Record<string, unknown>): unknown } } } }).c;
  const account = (await store.accounts.create({ kind: "imap", email: "synthetic@example.test", displayName: "S", color: "indigo", providerConfig: {}, now: 1 })).account.id;
  for (let i = 1; i <= 150_000; i++) c.db.table("messages").load({ id: i, account_id: account, thread_id: i, provider_msg_id: `m${i}`, rfc_message_id: "<reused@x>", from_email: "a@x", subject: `S${i}`, date: 1, size: 1, is_trash: 0, is_spam: 0 });
  const locations = store.providerStore(account).locations;
  const e = { subject: "S77", fromEmail: "a@x", date: 1, size: 1, rfcMessageId: "<reused@x>" };
  const t0 = performance.now();
  expect(await locations.twins(e, 0, 500)).toEqual([77]);
  const cold = performance.now() - t0;
  c.db.tx(() => c.db.table("threads").put({ id: 150_001, account_id: account, last_date: 1, unread_count: 0, message_count: 1 }));
  c.db.tx(() => c.db.table("messages").put({ id: 150_001, account_id: account, thread_id: 150_001, provider_msg_id: "m150001", rfc_message_id: "<reused@x>", from_email: "a@x", subject: "S77", date: 1, size: 1, is_trash: 0, is_spam: 0 }));
  const w0 = performance.now();
  expect(await locations.twins(e, 0, 500)).toEqual([77, 150_001]);
  const written = performance.now() - w0;
  console.log(`Message-ID twins among 150,000: cold ${cold.toFixed(1)} ms, after a write ${written.toFixed(1)} ms`);
  expect(cold).toBeLessThan(16 * MULT);
  expect(written).toBeLessThan(16 * MULT);
  await store.close();
});

it("Codex R50: 250 cold lookups of different envelopes among 50,000 sharing a Message-ID, and again after a write, in bounded time", { timeout: 1_200_000 }, async () => {
  const store = await IdbMailStore.open({ factory: new IDBFactory(), name: crypto.randomUUID(), instantSearch: false, platform });
  await store.whenLoaded();
  const c = (store as unknown as { c: { db: { tx<T>(fn: () => T): T; table(name: string): { load(row: Record<string, unknown>): void; put(row: Record<string, unknown>): unknown } } } }).c;
  const account = (await store.accounts.create({ kind: "imap", email: "synthetic@example.test", displayName: "S", color: "indigo", providerConfig: {}, now: 1 })).account.id;
  for (let i = 1; i <= 50_000; i++) c.db.table("messages").load({ id: i, account_id: account, thread_id: i, provider_msg_id: `m${i}`, rfc_message_id: "<reused@x>", from_email: "a@x", subject: `S${i}`, date: 1, size: 1, is_trash: 0, is_spam: 0 });
  const locations = store.providerStore(account).locations;
  // load-aware (timing.ts): on a busy machine a sample the OS held counts at its CPU time
  const lookups = async () => {
    const s = await sampleAsync(async () => {
      for (let i = 0; i < 250; i++) expect(await locations.twins({ subject: `S${i * 199 + 1}`, fromEmail: "a@x", date: 1, size: 1, rfcMessageId: "<reused@x>" }, 0, 500)).toEqual([i * 199 + 1]);
    });
    return settle([s]).ms[0]!;
  };
  const cold = await lookups();
  c.db.tx(() => c.db.table("threads").put({ id: 50_001, account_id: account, last_date: 1, unread_count: 0, message_count: 1 }));
  c.db.tx(() => c.db.table("messages").put({ id: 50_001, account_id: account, thread_id: 50_001, provider_msg_id: "m50001", rfc_message_id: "<reused@x>", from_email: "a@x", subject: "new", date: 1, size: 1, is_trash: 0, is_spam: 0 }));
  const after = await lookups();
  console.log(`250 cold twin lookups among 50,000 sharing a Message-ID: ${cold.toFixed(1)} ms, after a write ${after.toFixed(1)} ms`);
  expect(cold).toBeLessThan(25 * MULT);
  expect(after).toBeLessThan(25 * MULT);
  await store.close();
});

it("Codex R51: select all in a folder of 150,000 threads, cold and after an arrival, within the worker's stall budget", { timeout: 1_200_000 }, async () => {
  const store = await IdbMailStore.open({ factory: new IDBFactory(), name: crypto.randomUUID(), instantSearch: false, platform });
  await store.whenLoaded();
  const c = (store as unknown as { c: { db: { tx<T>(fn: () => T): T; table(name: string): { load(row: Record<string, unknown>): void; put(row: Record<string, unknown>): unknown } } } }).c;
  const account = (await store.accounts.create({ kind: "gmail", email: "synthetic@example.test", displayName: "S", color: "indigo", providerConfig: {}, now: 1 })).account.id;
  await store.folders.replace(account, [{ key: "Label_big", path: ["Big"], selectable: true }]);
  // ids in no order: nothing kept sorted to start from
  for (let n = 1; n <= 150_000; n++) {
    const i = ((n * 7919) % 150_000) + 1;
    c.db.table("threads").load({ id: i, account_id: account, last_date: i, unread_count: 0, message_count: 1, in_inbox: 0, in_trash: 0, in_spam: 0 });
    c.db.table("thread_folders").load({ thread_id: i, account_id: account, folder: "Label_big", last_date: i, unread: 0 });
  }
  const scope = { view: "all" as const, accountId: account, folder: "Label_big" };
  const coldSample = await sampleAsync(() => store.threads.scopeIds({ ...scope, after: 0, limit: 500 }));
  expect(coldSample.result).toEqual(Array.from({ length: 500 }, (_, i) => i + 1));
  const cold = settle([coldSample]).ms[0]!;
  // pages while the ids are built, then once kept
  const reads: number[] = [];
  for (let after = 500, i = 0; i < 20; i++, after += 500) {
    const s = await sampleAsync(() => store.threads.scopeIds({ ...scope, after, limit: 500 }));
    expect(s.result[0]).toBe(after + 1);
    reads.push(settle([s]).ms[0]!);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
  // an arrival: one more member
  c.db.table("threads").load({ id: 150_001, account_id: account, last_date: 1, unread_count: 0, message_count: 1, in_inbox: 0, in_trash: 0, in_spam: 0 });
  c.db.tx(() => c.db.table("thread_folders").put({ thread_id: 150_001, account_id: account, folder: "Label_big", last_date: 1, unread: 0 }));
  const afterSample = await sampleAsync(() => store.threads.scopeIds({ ...scope, after: 149_900, limit: 500 }));
  expect(afterSample.result.at(-1)).toBe(150_001);
  const arrival = settle([afterSample]).ms[0]!;
  console.log(`select all in a folder of 150,000: cold ${cold.toFixed(1)} ms, pages while built ${Math.max(...reads).toFixed(1)} ms, after an arrival ${arrival.toFixed(2)} ms`);
  expect(cold).toBeLessThan(32 * MULT);
  expect(Math.max(...reads)).toBeLessThan(32 * MULT);
  expect(arrival).toBeLessThan(2 * MULT);
  await store.close();
});

it("Codex R52: the cold select-all count of a folder of 60,000 members in reverse order within the worker's stall budget", { timeout: 1_200_000 }, async () => {
  const store = await IdbMailStore.open({ factory: new IDBFactory(), name: crypto.randomUUID(), instantSearch: false, platform });
  await store.whenLoaded();
  const c = (store as unknown as { c: { db: { table(name: string): { load(row: Record<string, unknown>): void } } } }).c;
  const account = (await store.accounts.create({ kind: "gmail", email: "synthetic@example.test", displayName: "S", color: "indigo", providerConfig: {}, now: 1 })).account.id;
  await store.folders.replace(account, [{ key: "Label_big", path: ["Big"], selectable: true }]);
  for (let i = 60_000; i >= 1; i--) {
    c.db.table("threads").load({ id: i, account_id: account, last_date: i, unread_count: 0, message_count: 1, in_inbox: 0, in_trash: 0, in_spam: 0 });
    c.db.table("thread_folders").load({ thread_id: i, account_id: account, folder: "Label_big", last_date: i, unread: 0 });
  }
  const s = await sampleAsync(() => store.threads.scopeCount({ view: "all", accountId: account, folder: "Label_big", limit: 100_001 }));
  const ms = settle([s]).ms[0]!;
  console.log(`cold select-all count of 60,000: ${ms.toFixed(1)} ms`);
  expect(s.result).toBe(60_000);
  expect(ms).toBeLessThan(32 * MULT);
  await store.close();
});
