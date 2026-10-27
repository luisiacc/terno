import { afterEach, describe, expect, it } from "vitest";
import type { FlagObservation } from "../types";
import type { MailStore } from "../mail-store";
import type { StoreHarness } from "./store";
import { ingest, msg, threadOf, withAccounts } from "./fixtures";

export function defineDurableFlagIntentConformance(name: string, harness: StoreHarness): void {
  const stores: MailStore[] = [];
  afterEach(async () => { for (const store of stores.splice(0)) if (store.isOpen) await store.close(); });
  // The legacy store has no activation capability; its ordinary sync path still reproduces the loss.
  const observe = (store: MailStore, accountId: number, authoritativeFlags = true) => store.sync.beginObservation?.(accountId, { authoritativeFlags }) ?? Promise.resolve(null);
  describe(`durable flag intent: ${name}`, () => {
    for (const action of ["markRead", "star", "archive"] as const) it.each(["flags", "ingest"] as const)(`${action} survives a pre-ack %s after success and reopen`, async (source) => {
      let store = await harness.open(); stores.push(store);
      const [accountId] = await withAccounts(store, 1);
      const original = msg({ accountId: accountId!, providerMsgId: "stable" });
      await ingest(store, [original]);
      const threadId = await threadOf(store, "stable");
      const old: FlagObservation | null = await observe(store, accountId!);
      const changed = await store.threads.act({ threadIds: [threadId], action, signal: null, now: 1 });
      const [op] = await store.ops.claimReady(2, 20);
      await store.ops.complete(op!.id, undefined, 3);
      const messageId = (await store.debug.snapshot()).messages[0]!.id;
      store = await harness.reopen(store); stores.push(store);
      if (source === "flags") await store.sync.updateFlags(accountId!, [{ messageId, expectedProviderMsgId: "stable", flags: { isRead: false, isStarred: false, inInbox: true } }], old ?? undefined);
      else await store.sync.ingest([original], { applyFilters: true, now: 4, classifier: null, observation: old ?? undefined });
      const expected = action === "markRead" ? { isRead: true } : action === "star" ? { isStarred: true } : { inInbox: false };
      expect((await store.debug.snapshot()).messages[0]).toMatchObject(expected);
      expect((await store.ops.get(changed.opIds[0]!))?.state).toBe("succeeded");
      const fresh = await observe(store, accountId!);
      await store.sync.updateFlags(accountId!, [{ messageId, expectedProviderMsgId: "stable", flags: { isRead: false, isStarred: false, inInbox: true } }], fresh ?? undefined);
      expect((await store.debug.snapshot()).messages[0]).toMatchObject({ isRead: false, isStarred: false, inInbox: true });
    });

    it("keeps incapable accounts inactive but refuses downgrade after durable activation", async () => {
      let store = await harness.open(); stores.push(store);
      const [accountId] = await withAccounts(store, 1);
      expect(await observe(store, accountId!, false)).toBeNull();
      await observe(store, accountId!);
      store = await harness.reopen(store); stores.push(store);
      await expect(observe(store, accountId!, false)).rejects.toMatchObject({ code: "AUTHORITATIVE_FLAGS_UNAVAILABLE" });
    });

    it("returns committed snapshot wakeups when an unattempted inverse creates no operation", async () => {
      const store = await harness.open(); stores.push(store);
      const [a] = await withAccounts(store, 1);
      await ingest(store, [msg({ accountId: a!, providerMsgId: "cancel" })]);
      const threadId = await threadOf(store, "cancel");
      const old = await observe(store, a!);
      await store.threads.act({ threadIds: [threadId], action: "markRead", signal: null, now: 1 });
      const undone = await store.threads.act({ threadIds: [threadId], action: "markUnread", signal: null, now: 2 });
      expect(undone.opIds).toEqual([]);
      expect(undone.flagReconcileAccounts).toEqual([a]);
      const id = (await store.debug.snapshot()).messages[0]!.id;
      await store.sync.updateFlags(a!, [{ messageId: id, expectedProviderMsgId: "cancel", flags: { isRead: true } }], old!);
      expect((await store.debug.snapshot()).messages[0]!.isRead).toBe(false);
      expect((await store.providerStore(a!).pendingFlagSnapshots({ limit: 50 })).items).toEqual([{ id, providerMsgId: "cancel" }]);
    });

    it("a surviving predecessor raises the newer cancellation barrier without acknowledging it", async () => {
      const store = await harness.open(); stores.push(store);
      const [a] = await withAccounts(store, 1);
      await ingest(store, [msg({ accountId: a!, providerMsgId: "survivor" })]);
      const threadId = await threadOf(store, "survivor");
      await observe(store, a!);
      await store.threads.act({ threadIds: [threadId], action: "markRead", signal: null, now: 1 });
      const [older] = await store.ops.claimReady(2, 20);
      await store.threads.act({ threadIds: [threadId], action: "markUnread", signal: null, now: 3 });
      await store.threads.act({ threadIds: [threadId], action: "markRead", signal: null, now: 4 });
      const middle = await observe(store, a!);
      await store.ops.complete(older!.id, undefined, 5);
      const id = (await store.debug.snapshot()).messages[0]!.id;
      await store.sync.updateFlags(a!, [{ messageId: id, expectedProviderMsgId: "survivor", flags: { isRead: false } }], middle!);
      expect((await store.debug.snapshot()).messages[0]!.isRead).toBe(true);
      const fresh = await observe(store, a!);
      await store.sync.updateFlags(a!, [{ messageId: id, expectedProviderMsgId: "survivor", flags: { isRead: false } }], fresh!);
      expect((await store.debug.snapshot()).messages[0]!.isRead).toBe(false);
    });

    it("unknown retry rearms the same current intention after a fresh remote reversal", async () => {
      let store = await harness.open(); stores.push(store);
      const [a] = await withAccounts(store, 1);
      await ingest(store, [msg({ accountId: a!, providerMsgId: "uncertain" })]);
      const threadId = await threadOf(store, "uncertain");
      await observe(store, a!);
      await store.threads.act({ threadIds: [threadId], action: "markRead", signal: null, now: 1 });
      const [op] = await store.ops.claimReady(2, 20);
      await store.ops.markUnknown(op!.id, "unknown", 3);
      const id = (await store.debug.snapshot()).messages[0]!.id;
      expect((await store.providerStore(a!).pendingFlagSnapshots({ limit: 50 })).items).toEqual([{ id, providerMsgId: "uncertain" }]);
      const fresh = await observe(store, a!);
      await store.sync.updateFlags(a!, [{ messageId: id, expectedProviderMsgId: "uncertain", flags: { isRead: false } }], fresh!);
      store = await harness.reopen(store); stores.push(store);
      await store.ops.resolveUnknown(op!.id, "retry", 4);
      expect((await store.debug.snapshot()).messages[0]!.isRead).toBe(true);
      expect((await store.ops.claimReady(5, 20)).map((row) => row.id)).toEqual([op!.id]);
      await store.ops.complete(op!.id, undefined, 6);
      await store.sync.updateFlags(a!, [{ messageId: id, expectedProviderMsgId: "uncertain", flags: { isRead: false } }], fresh!);
      expect((await store.debug.snapshot()).messages[0]!.isRead).toBe(true);
    });

    it("terminal flag failures retain a drainable snapshot obligation through reopen", async () => {
      let store = await harness.open(); stores.push(store);
      const [a] = await withAccounts(store, 1);
      await ingest(store, [msg({ accountId: a!, providerMsgId: "failed" })]);
      await observe(store, a!);
      await store.threads.act({ threadIds: [await threadOf(store, "failed")], action: "archive", signal: null, now: 1 });
      const [op] = await store.ops.claimReady(2, 20);
      await store.ops.fail(op!.id, "refused", false, 3);
      store = await harness.reopen(store); stores.push(store);
      const id = (await store.debug.snapshot()).messages[0]!.id;
      expect((await store.providerStore(a!).pendingFlagSnapshots({ limit: 50 })).items).toEqual([{ id, providerMsgId: "failed" }]);
    });

    it("epoch-bearing observations require the captured stable provider identity for every effect", async () => {
      const store = await harness.open(); stores.push(store);
      const [a] = await withAccounts(store, 1);
      await ingest(store, [msg({ accountId: a!, providerMsgId: "identity", gmailLabels: ["INBOX"] })]);
      const observation = await observe(store, a!);
      const id = (await store.debug.snapshot()).messages[0]!.id;
      for (const expectedProviderMsgId of [undefined, "other"]) await store.sync.updateFlags(a!, [{ messageId: id, expectedProviderMsgId, flags: { isRead: true, isSent: true }, gmailLabels: ["TRASH"] }], observation!);
      expect((await store.debug.snapshot()).messages[0]).toMatchObject({ isRead: false, isSent: false, gmailLabels: '["INBOX"]' });
    });
  });
}
