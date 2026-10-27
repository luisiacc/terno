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
  });
}
