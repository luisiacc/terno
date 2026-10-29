import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { ingest, msg, withAccounts } from "@terno/store/conformance";
import { expect, it, vi } from "vitest";
import { IdbMailStore } from "./store";

const platform = { uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((resolve) => setImmediate(resolve)) };

/** Plan 64 + 22: before the messages load, a trashed thread may be spam: its row must not allow a sender icon. */
it("trashed spam isn't icon-safe while the messages are still loading (an early read), nor after", async () => {
  const name = crypto.randomUUID();
  const factory = new IDBFactory();
  let store = await IdbMailStore.open({ name, factory, platform, instantSearch: false });
  const [acct] = await withAccounts(store, 1);
  const m = msg({ accountId: acct!, from: { name: "Promo", email: "deals@spammer.com" }, isSpam: true, inInbox: false });
  await ingest(store, [m]);
  const threadId = (await store.threads.list({ view: "spam", limit: 5, now: 0 })).items[0]!.id;
  await store.threads.act({ threadIds: [threadId], action: "trash", signal: null, now: 0 });
  // and one outside Trash and Spam: received spam beside the user's (not spam) reply, still in the Inbox
  const root = msg({ accountId: acct!, providerThreadId: "mixed", rfcMessageId: "mixed@x", from: { name: "Promo", email: "win@spammer.com" }, isSpam: true, inInbox: false });
  await ingest(store, [root, msg({ accountId: acct!, providerThreadId: "mixed", inReplyTo: "<mixed@x>", references: ["<mixed@x>"], from: { name: "Me", email: "me0@example.com" }, isSent: true, inInbox: true })]);
  const mixed = (await store.threads.list({ view: "inbox", limit: 5, now: 0 })).items.find((t) => t.subject === root.subject)!.id;
  await store.close();

  // the messages table's load waits for the gate: lists answer from the early tables
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const getAll = IDBObjectStore.prototype.getAll;
  let delayed = false;
  const spy = vi.spyOn(IDBObjectStore.prototype, "getAll").mockImplementation(function (this: IDBObjectStore, ...args) {
    const req = getAll.call(this, ...args);
    if (this.name !== "messages" || delayed) return req;
    delayed = true;
    return new Proxy(req, {
      get: (target, key) => Reflect.get(target, key, target),
      set: (target, key, value) => {
        if (key === "onsuccess") {
          target.onsuccess = (event) => void gate.then(() => value.call(target, event));
          return true;
        }
        return Reflect.set(target, key, value, target);
      },
    });
  });
  try {
    store = await IdbMailStore.open({ name, factory, platform, instantSearch: false });
    const early = (await store.threads.list({ view: "trash", limit: 5, now: 0 })).items.find((t) => t.id === threadId)!;
    expect(delayed).toBe(true);
    expect(early).toMatchObject({ inTrash: true, inSpam: false, hasSpam: true });
    const mixedEarly = (await store.threads.list({ view: "inbox", limit: 5, now: 0 })).items.find((t) => t.id === mixed)!;
    expect(mixedEarly).toMatchObject({ inTrash: false, inSpam: false, hasSpam: true });
    release();
    await store.whenLoaded();
    const later = (await store.threads.list({ view: "trash", limit: 5, now: 0 })).items.find((t) => t.id === threadId)!;
    expect(later).toMatchObject({ inTrash: true, inSpam: false, hasSpam: true });
    expect((await store.threads.list({ view: "inbox", limit: 5, now: 0 })).items.find((t) => t.id === mixed)).toMatchObject({ inSpam: false, hasSpam: true });
  } finally {
    release();
    spy.mockRestore();
    await store.close();
  }
});
