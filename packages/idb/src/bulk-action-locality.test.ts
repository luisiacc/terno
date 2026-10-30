import "fake-indexeddb/auto";
import { ingest, msg, withAccounts } from "@terno/store/conformance";
import { expect, it } from "vitest";
import { IdbMailStore } from "./store";

it("bulk stars group provider targets with linear numeric-array traversal and persist exact undo", async () => {
  const name = crypto.randomUUID();
  const options = { name, factory: indexedDB, instantSearch: false, platform: { uuid: () => crypto.randomUUID(), yield: async () => {} } };
  let store = await IdbMailStore.open(options);
  try {
    const [account] = await withAccounts(store, 1);
    const count = 512;
    await ingest(store, Array.from({ length: count }, (_, i) => msg({ accountId: account!, providerMsgId: `bulk-${i}`, providerThreadId: `thread-${i}`, isStarred: false })));
    const before = await store.debug.snapshot();
    const iterator = Array.prototype[Symbol.iterator];
    let visited = 0;
    Array.prototype[Symbol.iterator] = function* (this: unknown[]) {
      for (const value of iterator.call(this)) {
        if (typeof value === "number") visited++;
        yield value;
      }
      return undefined;
    };
    let result;
    try {
      result = await store.threads.act({ threadIds: before.threads.map((t) => t.id), action: "star", signal: null, now: 1 });
    } finally { Array.prototype[Symbol.iterator] = iterator; }
    expect(visited, "numeric array elements visited across the real command").toBeLessThanOrEqual(count * 32);
    expect((await store.debug.snapshot()).messages.every((m) => m.isStarred)).toBe(true);
    await store.debug.verify();
    expect(result.opIds).toHaveLength(1);
    expect(JSON.parse((await store.ops.get(result.opIds[0]!))!.target_json)).toEqual({ messageIds: before.messages.map((m) => m.id) });
    await store.close();
    store = await IdbMailStore.open(options);
    expect((await store.debug.snapshot()).messages.every((m) => m.isStarred)).toBe(true);
    await store.threads.restore({ messages: result.before, now: 2 });
    expect((await store.debug.snapshot()).messages).toEqual(before.messages);
    await store.debug.verify();
  } finally { await store.close(); }
});
