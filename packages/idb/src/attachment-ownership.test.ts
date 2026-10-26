import "fake-indexeddb/auto";
import { expect, it, vi } from "vitest";
import { IdbMailStore } from "./store";
import { withAccounts } from "@terno/store/conformance";

it("restores operation pins on aborted completion, including reopen", async () => {
  const options = { name: crypto.randomUUID(), factory: indexedDB, instantSearch: false, platform: { uuid: () => crypto.randomUUID(), yield: () => Promise.resolve() } };
  let store = await IdbMailStore.open(options);
  try {
    const [accountId] = await withAccounts(store, 1);
    const ref = await store.attachments.create({ accountId: accountId!, filename: "empty", mime: "text/plain", size: 0, now: 0 });
    await store.attachments.seal(accountId!, ref.assetId);
    const send = await store.compose.queueSend({ accountId: accountId!, to: [], cc: [], bcc: [], subject: "atomic", bodyText: "", attachments: [ref], recordReply: false, now: 0 });
    await store.ops.claimReady(0, 1);
    await store.sync.remove([(await store.threads.get(send.threadId))!.messages[0]!.id]);
    const transaction = IDBDatabase.prototype.transaction;
    const spy = vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, ...args) {
      const tx = transaction.call(this, ...args);
      if (args[1] === "readwrite") queueMicrotask(() => tx.abort());
      return tx;
    });
    await expect(store.ops.complete(send.opId, {}, 1)).rejects.toThrow(); spy.mockRestore();
    expect((await store.ops.get(send.opId))!.state).toBe("running");
    await expect(store.attachments.discard(accountId!, ref.assetId)).rejects.toThrow();
    await store.close(); store = await IdbMailStore.open(options);
    await expect(store.attachments.discard(accountId!, ref.assetId)).rejects.toThrow();
    await store.ops.complete(send.opId, {}, 2);
    await store.attachments.discard(accountId!, ref.assetId);
  } finally { vi.restoreAllMocks(); await store.close(); }
});
