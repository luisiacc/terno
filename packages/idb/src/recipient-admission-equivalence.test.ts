import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { expect, it, vi } from "vitest";
import { IdbMailStore } from "./store";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

it("retains all recipient occurrences and searches them immediately after admission", async () => {
  const store = await IdbMailStore.open({ factory: new IDBFactory(), name: crypto.randomUUID(), instantSearch: false, platform: { uuid: () => crypto.randomUUID(), yield: tick } });
  try {
    const { account } = await store.accounts.create({ kind: "imap", email: "synthetic@example.test", displayName: "Synthetic", color: "indigo", providerConfig: { appendToSent: false }, now: 1 });
    const to = Array.from({ length: 80 }, (_, index) => ({ name: index === 79 ? "Éxample Boundary" : `Filler ${index}`, email: `r${index}@example.test` }));
    const cc = [to[0]!], bcc = [{ name: "Hidden Last", email: "hidden@example.test" }];
    const queued = await store.compose.queueSend({ accountId: account.id, to, cc, bcc, subject: "Synthetic", bodyText: "Exact", recordReply: false, now: 2 });
    const payload = JSON.parse((await store.ops.get(queued.opId))!.payload_json); expect({ to: payload.to, cc: payload.cc, bcc: payload.bcc }).toEqual({ to, cc, bcc });
    for (const query of ['to:"example boundary"', 'to:"hidden last"', 'to:r79@example.test']) expect((await store.threads.searchText({ query, accountId: account.id, now: 3, limit: 10 })).items).toHaveLength(1);
  } finally { await store.close(); }
});

it("keeps the draft and no admitted message when the native transaction aborts", async () => {
  const factory = new IDBFactory(), name = crypto.randomUUID();
  const store = await IdbMailStore.open({ factory, name, instantSearch: false, platform: { uuid: () => crypto.randomUUID(), yield: tick } });
  try {
    const { account } = await store.accounts.create({ kind: "imap", email: "synthetic@example.test", displayName: "Synthetic", color: "indigo", providerConfig: { appendToSent: false }, now: 1 });
    const to = Array.from({ length: 80 }, (_, index) => ({ name: "Rollback Probe", email: `r${index}@example.test` }));
    const draft = (await store.drafts.save({ accountId: account.id, to, cc: [], bcc: [], subject: "Atomic", bodyText: "Exact" }, 1))!;
    const put = IDBObjectStore.prototype.put; let aborted = false;
    const spy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) { const request = Reflect.apply(put, this, args) as IDBRequest; if (this.name === "recipient_receipts" && this.transaction.db.name === `terno-${name}`) request.addEventListener("success", () => { aborted = true; this.transaction.abort(); }); return request; });
    try { await expect(store.compose.queueSend({ accountId: account.id, to, cc: [], bcc: [], subject: "Atomic", bodyText: "Exact", draftId: draft.id, draftGeneration: draft.generation, draftRevision: draft.revision, recordReply: false, now: 2 })).rejects.toThrow(); }
    finally { spy.mockRestore(); }
    expect(aborted).toBe(true); expect((await store.drafts.list()).find((entry) => entry.id === draft.id)).toEqual(draft);
    expect(await store.recipientReceipts.list(account.id)).toEqual([]); expect((await store.ops.recent(100)).filter((entry) => entry.kind === "send")).toEqual([]);
    expect((await store.threads.searchText({ query: 'to:"rollback probe"', accountId: account.id, now: 3, limit: 10 })).items).toEqual([]);
  } finally { vi.restoreAllMocks(); await store.close(); }
});

it("refuses a draft edited during asynchronous recipient preparation", async () => {
  const factory = new IDBFactory(); let edit: (() => Promise<void>) | undefined, yields = 0;
  const store = await IdbMailStore.open({ factory, name: crypto.randomUUID(), instantSearch: false, platform: { uuid: () => crypto.randomUUID(), yield: async () => { yields++; if (edit && yields === 2) { const work = edit; edit = undefined; await work(); } else await tick(); } } });
  try {
    const { account } = await store.accounts.create({ kind: "imap", email: "synthetic@example.test", displayName: "Synthetic", color: "indigo", providerConfig: { appendToSent: false }, now: 1 });
    const to = Array.from({ length: 80 }, (_, index) => ({ name: "Synthetic", email: `r${index}@example.test` }));
    const draft = (await store.drafts.save({ accountId: account.id, to, cc: [], bcc: [], subject: "Original", bodyText: "Original" }, 1))!;
    yields = 0; edit = async () => { await store.drafts.save({ id: draft.id, generation: draft.generation, baseRevision: draft.revision, accountId: account.id, to, cc: [], bcc: [], subject: "Edited", bodyText: "Still here" }, 2); };
    await expect(store.compose.queueSend({ accountId: account.id, to, cc: [], bcc: [], subject: "Original", bodyText: "Original", draftId: draft.id, draftGeneration: draft.generation, draftRevision: draft.revision, recordReply: false, now: 3 })).rejects.toMatchObject({ code: "STALE" });
    expect((await store.drafts.list()).find((entry) => entry.id === draft.id)).toMatchObject({ subject: "Edited", body_text: "Still here" }); expect(await store.recipientReceipts.list(account.id)).toEqual([]);
  } finally { await store.close(); }
});
