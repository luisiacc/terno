import { afterEach, describe, expect, it } from "vitest";
import type { MailStore } from "../mail-store";
import type { StoreHarness } from "./store";
import { ingest, msg, threadOf, withAccounts } from "./fixtures";

export function defineW02ActionConformance(name: string, harness: StoreHarness): void {
  const stores: MailStore[] = [];
  afterEach(async () => { for (const store of stores.splice(0)) if (store.isOpen) await store.close(); });
  describe(`W02 parked independent versions: ${name}`, () => {
    it("rejects superseded unknown read retry but preserves independent star retry across archive and reopen", async () => {
      let store = await harness.open(); stores.push(store);
      const [a, b] = await withAccounts(store);
      await ingest(store, [msg({ accountId: a!, providerMsgId: "target" }), msg({ accountId: b!, providerMsgId: "target" })]);
      const initial = await store.debug.snapshot();
      const target = initial.messages.find((m) => m.accountId === a)!, sibling = initial.messages.find((m) => m.accountId === b)!;
      const old = (await store.sync.beginObservation(a!, { authoritativeFlags: true }))!;
      expect(old).not.toBeNull();
      const act = (action: "markRead" | "markUnread" | "star" | "archive", now: number) => store.threads.act({ threadIds: [target.threadId], action, signal: null, now });
      await act("markRead", 1);
      const [read] = await store.ops.claimReady(2, 20);
      await store.ops.markUnknown(read!.id, "Synthetic unknown", 3);
      const fresh = (await store.sync.beginObservation(a!, { authoritativeFlags: true }))!;
      await store.sync.updateFlags(a!, [{ messageId: target.id, expectedProviderMsgId: "target", flags: { isRead: false } }], fresh);
      expect((await act("markUnread", 4)).opIds).toEqual([]);
      await act("star", 5);
      const [star] = await store.ops.claimReady(6, 20);
      expect(star?.kind).toBe("star");
      await store.ops.markUnknown(star!.id, "Synthetic unknown", 7);
      await act("archive", 8);
      const [archive] = await store.ops.claimReady(9, 20);
      expect(archive?.kind).toBe("archive");
      await store.ops.complete(archive!.id, undefined, 10);
      store = await harness.reopen(store); stores.push(store);
      const parked = await store.ops.get(read!.id);
      await expect(store.ops.resolveUnknown(read!.id, "retry", 11)).rejects.toMatchObject({ code: "STALE" });
      // Late callbacks cannot revive terminal/unknown work or retire newer intent.
      await store.ops.complete(read!.id, undefined, 12);
      await store.ops.fail(read!.id, "Synthetic stale failure", false, 13);
      expect(await store.ops.get(read!.id)).toEqual(parked);
      await store.ops.resolveUnknown(star!.id, "retry", 14);
      const [retry] = await store.ops.claimReady(15, 20);
      expect(retry?.id).toBe(star!.id);
      expect(JSON.parse(retry!.target_json).messageIds).toEqual([target.id]);
      await store.ops.complete(retry!.id, undefined, 16);
      await store.sync.updateFlags(a!, [{ messageId: target.id, expectedProviderMsgId: "target", flags: { isRead: true, isStarred: false, inInbox: true } }], old);
      expect((await store.debug.snapshot()).messages.find((m) => m.id === target.id)).toMatchObject({ isRead: false, isStarred: true, inInbox: false });
      // Cross-account and stale-identity observations cannot substitute for the exact source.
      const current = (await store.sync.beginObservation(a!, { authoritativeFlags: true }))!;
      await store.sync.updateFlags(b!, [{ messageId: target.id, expectedProviderMsgId: "target", flags: { isRead: true } }], current);
      await store.sync.updateFlags(a!, [{ messageId: target.id, expectedProviderMsgId: "wrong", flags: { isRead: true } }], current);
      expect((await store.debug.snapshot()).messages.find((m) => m.id === target.id)?.isRead).toBe(false);
      // Fresh independent external changes must still apply; this rejects permanent optimistic fences.
      await store.sync.updateFlags(a!, [{ messageId: target.id, expectedProviderMsgId: "target", flags: { isRead: true, isStarred: false, inInbox: true } }], current);
      const after = await store.debug.snapshot();
      expect(after.messages.find((m) => m.id === target.id)).toMatchObject({ isRead: true, isStarred: false, inInbox: true });
      expect(after.messages.find((m) => m.id === sibling.id)).toEqual(sibling);
      expect((await store.providerStore(a!).pendingFlagSnapshots({ limit: 50 })).items).toEqual([]);
      expect(await store.ops.claimReady(17, 20)).toEqual([]);
      await store.debug.verify();
    });

    it("auth-parked older read remains owned while newer independent star/location intent settles", async () => {
      let store = await harness.open(); stores.push(store);
      const [a] = await withAccounts(store, 1);
      await ingest(store, [msg({ accountId: a!, providerMsgId: "parked-auth" })]);
      const threadId = await threadOf(store, "parked-auth");
      const old = (await store.sync.beginObservation(a!, { authoritativeFlags: true }))!;
      await store.threads.act({ threadIds: [threadId], action: "markRead", signal: null, now: 1 });
      const [read] = await store.ops.claimReady(2, 20);
      await store.ops.awaitAuth(read!.id, "Synthetic auth pause", 3);
      for (const action of ["star", "archive"] as const) await store.threads.act({ threadIds: [threadId], action, signal: null, now: 4 });
      store = await harness.reopen(store); stores.push(store);
      expect(await store.ops.get(read!.id)).toMatchObject({ state: "queued", attempts: 0 });
      const independent = await store.ops.claimReady(5, 20);
      expect(independent.map((op) => op.kind)).toEqual(["star", "archive"]);
      for (const op of independent) await store.ops.complete(op.id, undefined, 6);
      expect(await store.ops.get(read!.id)).toMatchObject({ state: "queued", attempts: 0 });
      await store.ops.resumeAuth(a!, 8);
      const resumed = await store.ops.claimReady(9, 20);
      expect(resumed.map((op) => op.id)).toEqual([read!.id]);
      await store.ops.complete(resumed[0]!.id, undefined, 10);
      const id = (await store.debug.snapshot()).messages[0]!.id;
      await store.sync.updateFlags(a!, [{ messageId: id, expectedProviderMsgId: "parked-auth", flags: { isRead: false, isStarred: false, inInbox: true } }], old);
      expect((await store.debug.snapshot()).messages[0]).toMatchObject({ isRead: true, isStarred: true, inInbox: false });
      expect((await store.ops.get(read!.id))?.state).toBe("succeeded");
      expect((await store.ops.get(read!.id))?.attempts).toBe(1);
      expect(await store.ops.claimReady(20, 20)).toEqual([]);
      expect((await store.debug.snapshot()).ops.map((op) => [op.kind, op.state, op.attempts, op.messageIds])).toEqual([
        ["markRead", "succeeded", 1, [id]], ["star", "succeeded", 1, [id]], ["archive", "succeeded", 1, [id]],
      ]);
      const current = (await store.sync.beginObservation(a!, { authoritativeFlags: true }))!;
      await store.sync.updateFlags(a!, [{ messageId: id, expectedProviderMsgId: "parked-auth", flags: { isRead: false, isStarred: false, inInbox: true } }], current);
      expect((await store.debug.snapshot()).messages[0]).toMatchObject({ isRead: false, isStarred: false, inInbox: true });
      expect((await store.providerStore(a!).pendingFlagSnapshots({ limit: 50 })).items).toEqual([]);
      await store.debug.verify();
    });
  });
}
