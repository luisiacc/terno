import "fake-indexeddb/auto";
import { expect, it, vi } from "vitest";
import { msg, withAccounts } from "../../store/src/conformance/fixtures";
import { EXPORT_LEASES_MAX, IdbMailStore } from "./store";

/**
 * Plan 107, Codex code review round 27 #3: a body past the body cache's budget (8 MB) went after every call, so an
 * export read a 20 MB body whole again for each 256 KB stretch. Under its session's lease it's read once, and the
 * lease lets it go when the session ends.
 */
const platform = { uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((resolve) => setTimeout(resolve, 0)) };
const STRETCH = 256 * 1024;

it("a 20 MB body is read once an export, and read again only after its lease is released", async () => {
  const store = await IdbMailStore.open({ name: `lease-${crypto.randomUUID()}`, factory: indexedDB, platform, instantSearch: false });
  try {
    const [accountId] = await withAccounts(store, 1);
    // 20 MB as the cache counts it (UTF-16)
    const body = "ab\r\nFrom c".repeat(1_048_576);
    const { inserted } = await store.sync.ingest([msg({ accountId: accountId!, providerMsgId: "big", bodyText: body, bodyHtml: null })], { applyFilters: false, now: 0, classifier: null });
    const id = inserted[0]!;
    // past the cache's budget: not kept after the write
    expect(store.bodyCache().bytes).toBe(0);
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
      expect(reads).toEqual([id]);
      // the cache stays within its budget: the lease holds it apart
      expect(store.bodyCache().bytes).toBe(0);
      // a cancel (or a finish, or an idle session) releases it: the next export reads it again
      store.folderExport.release("e1");
      expect((store as unknown as { exportLeases: Map<string, unknown> }).exportLeases.size).toBe(0);
      await store.folderExport.body(id, "text", 0, STRETCH, "e1");
      expect(reads).toEqual([id, id]);
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
