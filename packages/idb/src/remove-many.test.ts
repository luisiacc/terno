// @vitest-environment node
/**
 * Plan 68 (Codex R36, R48): an expunge's membership decision in IndexedDB: a thread whose other message is made
 * eligible between its decision and the delete ("Not spam") keeps its place (the watch marks it).
 */
import "fake-indexeddb/auto";
import { ingest, msg, withAccounts } from "@terno/store/conformance";
import { IDBFactory } from "fake-indexeddb";
import { expect, it } from "vitest";
import { IdbMailStore } from "./store";

const platform = { uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((resolve) => setImmediate(resolve)) };

it("a message of the thread made eligible between the decision and the delete keeps the thread in the folder", async () => {
  const store = await IdbMailStore.open({ factory: new IDBFactory(), name: crypto.randomUUID(), instantSearch: false, platform });
  const [, m] = await withAccounts(store);
  await store.folders.replace(m!, [{ key: "F", path: ["F"], selectable: true }]);
  const loc = (uid: number) => [{ mailbox: "F", uidvalidity: 1, uid, flags: [] as string[] }];
  const r = await ingest(store, [msg({ accountId: m!, providerMsgId: "a", providerThreadId: "t", locations: loc(1) }), msg({ accountId: m!, providerMsgId: "b", providerThreadId: "t", isSpam: true, locations: loc(2) })]);
  const inF = async () => (await store.threads.list({ view: "all", accountId: m!, folder: "F", limit: 10 })).items.length;
  expect(await inF()).toBe(1);
  const locations = store.providerStore(m!).locations as unknown as { command: (fn: () => unknown) => Promise<unknown> };
  const original = locations.command;
  let calls = 0;
  // the second command is the delete of the decided rows: just before it, the spam one is marked not spam
  locations.command = async (fn) => {
    if (++calls === 2) await store.threads.act({ threadIds: [(await store.debug.snapshot()).messages.find((x) => x.id === r.inserted[1])!.threadId], action: "notSpam", signal: null, now: 0 });
    return original(fn);
  };
  try {
    await (store.providerStore(m!).locations as unknown as typeof locations & { removeMany(ids: number[], mailbox: string): Promise<void> }).removeMany.call(locations, [r.inserted[0]!], "F");
  } finally {
    locations.command = original;
  }
  expect(calls).toBeGreaterThanOrEqual(2);
  expect(await inF()).toBe(1);
  await store.close();
});
