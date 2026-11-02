import "fake-indexeddb/auto";
import { expect, it, vi } from "vitest";
import { msg, withAccounts } from "../../store/src/conformance/fixtures";
import { nodePlatform } from "../../db/src/node-driver";
import { EXPORT_LEASES_MAX, IdbMailStore } from "./store";

/**
 * Plan107's 20 MB export remains exact after captured bodies replace whole-record clones. Its cached manifest
 * needs no native body-record read per stretch; bounded parts supply the content. Inline leases still invalidate
 * on writes and retain at most the original number of sessions.
 */
const platform = nodePlatform;
const STRETCH = 256 * 1024;

it("a 20 MB captured body exports bounded exact parts while inline session leases retain their bounds", async () => {
  const store = await IdbMailStore.open({ name: `lease-${crypto.randomUUID()}`, factory: indexedDB, platform, instantSearch: false });
  try {
    const [accountId] = await withAccounts(store, 1);
    // 20 MB as the cache counts it (UTF-16)
    const body = "ab\r\nFrom c".repeat(1_048_576);
    const { inserted } = await store.sync.ingest([msg({ accountId: accountId!, providerMsgId: "big", bodyText: body, bodyHtml: null })], { applyFilters: false, now: 0, classifier: null });
    const id = inserted[0]!;
    // Only the existing 4,096-unit preview is retained in the cache, never the complete body.
    expect(store.bodyCache().bytes).toBe(8192);
    const reads: unknown[] = [];
    const get = IDBObjectStore.prototype.get;
    const spy = vi.spyOn(IDBObjectStore.prototype, "get").mockImplementation(function (this: IDBObjectStore, key) {
      if (this.name === "message_bodies") reads.push(key);
      return get.call(this, key);
    });
    const exportAll = async (lease: string) => {
      const parts: string[] = [];
      for (let at: number | null = 0; at !== null; ) {
        const r = await store.folderExport.body(id, "text", at, STRETCH, lease);
        parts.push(r!.text);
        at = r!.next;
      }
      return parts.join("");
    };
    try {
      expect(await exportAll("e1")).toBe(body);
      expect(reads).toEqual([]);
      // The complete content stayed in durable parts; the cache still owns only the preview.
      expect(store.bodyCache().bytes).toBe(8192);
      // a cancel (or a finish, or an idle session) releases it: the next export reads it again
      store.folderExport.release("e1");
      expect((store as unknown as { exportLeases: Map<string, unknown> }).exportLeases.size).toBe(0);
      await store.folderExport.body(id, "text", 0, STRETCH, "e1");
      expect(reads).toEqual([]);
      // a write to the message lets it go too: what's exported is what's stored
      const update = await store.sync.ingest([msg({ accountId: accountId!, providerMsgId: "big", bodyText: "fresh", bodyHtml: null })], { applyFilters: false, now: 0, classifier: null });
      expect(update.inserted).toEqual([]);
      expect(await store.folderExport.body(id, "text", 0, STRETCH, "e1")).toEqual({ text: "fresh", next: null });
      // bounded: more sessions than it keeps let the oldest go
      for (let i = 0; i < EXPORT_LEASES_MAX + 1; i++) await store.folderExport.body(id, "text", 0, STRETCH, `s${i}`);
      expect((store as unknown as { exportLeases: Map<string, unknown> }).exportLeases.size).toBe(EXPORT_LEASES_MAX);
    } finally {
      spy.mockRestore();
    }
  } finally {
    await store.close();
  }
}, 60_000);
