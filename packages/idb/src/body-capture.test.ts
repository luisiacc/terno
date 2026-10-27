import "fake-indexeddb/auto";
import { defineBodyCaptureConformance } from "../../store/src/conformance/body-capture";
import { IdbMailStore } from "./store";
import { describe, expect, it, vi } from "vitest";
import { msg, withAccounts } from "../../store/src/conformance/fixtures";

const platform = { uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((resolve) => setTimeout(resolve, 0)) };
for (const instantSearch of [false, true]) defineBodyCaptureConformance(`IDB (instant=${instantSearch})`, {
  open: () => IdbMailStore.open({ name: `body-${crypto.randomUUID()}`, factory: indexedDB, platform, instantSearch }),
  reopen: async (store) => { const name = (store as IdbMailStore).name; await store.close(); return IdbMailStore.open({ name, factory: indexedDB, platform, instantSearch }); },
});

for (const instantSearch of [false, true]) describe(`incomplete body reads (instant=${instantSearch})`, () => {
  it("does not read cold incomplete bodies for selection or preview after reopen", async () => {
    const name = `body-reads-${crypto.randomUUID()}`;
    let store = await IdbMailStore.open({ name, factory: indexedDB, platform, instantSearch });
    try {
      const [accountId] = await withAccounts(store, 1);
      const messages = Array.from({ length: 2003 }, (_, i) => msg({ accountId: accountId!, providerMsgId: `cold-${i}`, bodyState: i === 0 ? "full" : "partial", bodyText: "visible needle" }));
      const result = await store.sync.ingest(messages, { applyFilters: false, now: 0, classifier: null });
      const full = result.inserted[0]!, partial = result.inserted[1]!;
      await store.close();
      store = await IdbMailStore.open({ name, factory: indexedDB, platform, instantSearch });
      if (store.instant) expect(await store.instant.settled()).toBe(true);
      const reads: unknown[] = [];
      const get = IDBObjectStore.prototype.get;
      const spy = vi.spyOn(IDBObjectStore.prototype, "get").mockImplementation(function (this: IDBObjectStore, key) {
        if (this.name === "message_bodies") reads.push(key);
        return get.call(this, key);
      });
      try {
        const rule = { match: "all" as const, conditions: [{ field: "body" as const, op: "contains" as const, value: "needle" }], actions: [{ type: "star" as const }] };
        expect(await store.filters.matchWindow(rule, 0, { from: partial, to: partial })).toEqual([]);
        expect(reads).toEqual([]);
        expect((await store.filters.preview(rule, 0, 5)).count).toBe(1);
        expect(reads).not.toContain(partial);
        expect(reads).toContain(full);
        reads.length = 0;
        const header = { ...rule, conditions: [{ field: "subject" as const, op: "contains" as const, value: "Subject" }] };
        expect(await store.filters.matchWindow(header, 0, { from: partial, to: partial })).toEqual([partial]);
        expect(reads).toEqual([]);
      } finally { spy.mockRestore(); }
    } finally { if (store.isOpen) await store.close(); }
  });
});
