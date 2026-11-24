/**
 * Plan 86: a web mailbox from before schema 37 has no categories and no tabs. The upgrade marks a backfill (with a
 * Gmail account) that the backend's runner drives slice by slice; a close mid-way resumes from its progress, and
 * until a thread is done it stays in the Inbox.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { ingest, msg, threadOf, withAccounts } from "@terno/store/conformance";
import { afterEach, expect, it } from "vitest";
import { databaseName } from "./schema";
import { IdbMailStore } from "./store";

const platform = { uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((resolve) => setImmediate(resolve)) };
const request = <T,>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
const done = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
const opened: IdbMailStore[] = [];
afterEach(async () => {
  for (const s of opened.splice(0)) if (s.isOpen) await s.close();
});
const open = async (factory: IDBFactory, name: string) => {
  const store = await IdbMailStore.open({ factory, name, instantSearch: false, platform });
  opened.push(store);
  return store;
};

/** Every row of a store rewritten (what schema 33 left: no category on messages, no tab on threads). */
async function rewrite(factory: IDBFactory, name: string, edit: Record<string, (row: Record<string, unknown>) => void>, schema: number) {
  const raw = await request(factory.open(databaseName(name)));
  const tx2 = raw.transaction([...Object.keys(edit), "meta"], "readwrite");
  for (const [table, change] of Object.entries(edit)) {
    const s = tx2.objectStore(table);
    s.openCursor().onsuccess = (e) => {
      const cursor = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
      if (!cursor) return;
      const row = { ...(cursor.value as Record<string, unknown>) };
      change(row);
      cursor.update(row);
      cursor.continue();
    };
  }
  tx2.objectStore("meta").put(schema, "logicalSchema");
  await done(tx2);
  raw.close();
}

it("a mailbox from before gets its tabs once, in slices that resume after a close", async () => {
  const factory = new IDBFactory();
  const name = "tabs-upgrade";
  let store = await open(factory, name);
  const [gmail, imap] = await withAccounts(store, 2);
  const promos = Array.from({ length: 5 }, (_, i) => msg({ accountId: gmail!, providerMsgId: `promo${i}`, from: { name: "", email: `deals${i}@shop.com` }, gmailLabels: ["INBOX", "CATEGORY_PROMOTIONS"] }));
  await ingest(store, [...promos, msg({ accountId: gmail!, providerMsgId: "person", gmailLabels: ["INBOX", "CATEGORY_PERSONAL"] }), msg({ accountId: imap!, providerMsgId: "imap" })]);
  const person = await threadOf(store, "person");
  const tabbed = await Promise.all(promos.map((m) => threadOf(store, m.providerMsgId!)));
  expect((await store.threads.list({ view: "inbox", limit: 20 })).items).toHaveLength(2);
  await store.close();
  await rewrite(factory, name, { messages: (r) => void delete r.category, threads: (r) => void delete r.tab }, 36);

  store = await open(factory, name);
  await store.whenLoaded();
  // not done yet: every thread is shown
  expect((await store.threads.list({ view: "inbox", limit: 20 })).items).toHaveLength(7);
  expect(await store.tabs.idle()).toBe(false);
  // a move the user makes meanwhile is theirs: the backfill never overwrites it
  await store.threads.act({ threadIds: [tabbed[0]!], action: "toPrimary", signal: null, now: 1 });
  for (let i = 0; i < 3; i++) await store.tabs.backfill({ limit: 2 });
  await store.close();

  store = await open(factory, name);
  await store.whenLoaded();
  let slices = 0;
  while ((await store.tabs.backfill({ limit: 2 })).more) slices++;
  expect(slices).toBeGreaterThan(0);
  expect(await store.tabs.idle()).toBe(true);
  const inbox = (await store.threads.list({ view: "inbox", limit: 20 })).items.map((t) => t.id);
  expect(inbox).toEqual(expect.arrayContaining([person, tabbed[0]!]));
  expect(inbox).toHaveLength(3);
  expect((await store.threads.list({ view: "inbox", accountId: gmail!, tab: "promotions", limit: 20 })).items.map((t) => t.id).sort()).toEqual(tabbed.slice(1).sort());
  await store.close();
  // done once: a reopen has nothing to do
  store = await open(factory, name);
  expect(await store.tabs.idle()).toBe(true);
});

it("a mailbox without a Gmail account has nothing to backfill", async () => {
  const factory = new IDBFactory();
  const name = "tabs-imap-only";
  let store = await open(factory, name);
  const [, imap] = await withAccounts(store, 2);
  await store.accounts.remove(1);
  await ingest(store, [msg({ accountId: imap! })]);
  await store.close();
  await rewrite(factory, name, {}, 36);
  store = await open(factory, name);
  expect(await store.tabs.idle()).toBe(true);
});

it("a slice stops once it has read its share of messages, mid-window, and the next goes on from there", async () => {
  const factory = new IDBFactory();
  const name = "tabs-budget";
  let store = await open(factory, name);
  const [gmail] = await withAccounts(store, 1);
  for (let t = 0; t < 4; t++) await ingest(store, [0, 1, 2].map((i) => msg({ accountId: gmail!, providerMsgId: `t${t}m${i}`, providerThreadId: `gt${t}`, from: { name: "", email: `deals${t}@shop.com` }, gmailLabels: ["INBOX", "CATEGORY_PROMOTIONS"] })));
  const threads = await Promise.all([0, 1, 2, 3].map((t) => threadOf(store, `t${t}m0`)));
  await store.close();
  await rewrite(factory, name, { threads: (r) => void delete r.tab }, 36);
  store = await open(factory, name);
  await store.whenLoaded();
  // the messages phase first (twelve ids, in one slice)
  await store.tabs.backfill({ limit: 100 });
  const tabbed = async () => (await store.threads.list({ view: "inbox", accountId: gmail!, tab: "promotions", limit: 10 })).items.length;
  for (let slice = 1; slice <= threads.length; slice++) {
    const r = await store.tabs.backfill({ limit: 2 });
    expect(await tabbed()).toBe(slice);
    expect(r.more).toBe(slice < threads.length);
  }
  expect(await store.tabs.idle()).toBe(true);
});

// with no pass under way, and with one in its threads phase already past every thread (Codex critique: it starts again)
it.each([["no pass under way", null], ["a pass past every thread", '{"phase":"threads","after":1000000,"max":1000000}']] as const)("schema 78 (plan 256): a mailbox from before learns which Inbox conversations are only your own mail, in the tabs' slices (%s)", async (_, job) => {
  const factory = new IDBFactory();
  const name = "tabs-only-yours";
  let store = await open(factory, name);
  const [gmail] = await withAccounts(store, 1);
  await ingest(store, [
    msg({ accountId: gmail!, providerMsgId: "note", from: { name: "", email: "me0@example.com" }, isSent: true, gmailLabels: ["SENT", "INBOX"] }),
    msg({ accountId: gmail!, providerMsgId: "person", gmailLabels: ["INBOX", "CATEGORY_PERSONAL"] }),
  ]);
  const note = await threadOf(store, "note");
  const person = await threadOf(store, "person");
  await store.close();
  // what schema 77 was: no fact on the rows
  await rewrite(factory, name, { threads: (r) => void delete r.only_yours }, 77);
  if (job) {
    const raw = await request(factory.open(databaseName(name)));
    const tx = raw.transaction(["settings"], "readwrite");
    tx.objectStore("settings").put({ key: "tabs_backfill", value_json: job }, "tabs_backfill");
    await done(tx);
    raw.close();
  }

  store = await open(factory, name);
  await store.whenLoaded();
  expect((await store.threads.summaries([note]))[0]!.onlyYours).toBeUndefined();
  expect(await store.tabs.idle()).toBe(false);
  while ((await store.tabs.backfill({ limit: 50 })).more);
  expect(await store.tabs.idle()).toBe(true);
  const rows = new Map((await store.threads.summaries([note, person])).map((t) => [t.id, t.onlyYours]));
  expect([rows.get(note), rows.get(person)]).toEqual([true, undefined]);
  // and a mailbox already at 78 asks for nothing on open
  await store.close();
  store = await open(factory, name);
  expect(await store.tabs.idle()).toBe(true);
});
