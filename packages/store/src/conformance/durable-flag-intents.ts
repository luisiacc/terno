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

    it.each(["flags", "ingest"] as const)("confirmed ownership rejects old %s replay after reopen but allows a later remote reversal", async (source) => {
      let store = await harness.open(); stores.push(store);
      const [a] = await withAccounts(store, 1);
      const original = msg({ accountId: a!, providerMsgId: "confirmed" });
      await ingest(store, [original]);
      const old = (await observe(store, a!))!;
      await store.threads.act({ threadIds: [await threadOf(store, "confirmed")], action: "archive", signal: null, now: 1 });
      const [op] = await store.ops.claimReady(2, 20);
      await store.ops.complete(op!.id, undefined, 3);
      const id = (await store.debug.snapshot()).messages[0]!.id;
      const confirmed = (await observe(store, a!))!;
      await store.sync.updateFlags(a!, [{ messageId: id, expectedProviderMsgId: "confirmed", flags: { inInbox: false } }], confirmed);
      expect((await store.providerStore(a!).pendingFlagSnapshots({ limit: 50 })).items).toEqual([]);
      store = await harness.reopen(store); stores.push(store);
      if (source === "flags") await store.sync.updateFlags(a!, [{ messageId: id, expectedProviderMsgId: "confirmed", flags: { inInbox: true, isStarred: true } }], old);
      else await store.sync.ingest([{ ...original, isStarred: true }], { applyFilters: true, now: 4, classifier: null, observation: old });
      expect((await store.debug.snapshot()).messages[0]).toMatchObject({ inInbox: false, isStarred: true });
      const later = (await observe(store, a!))!;
      await store.sync.updateFlags(a!, [{ messageId: id, expectedProviderMsgId: "confirmed", flags: { inInbox: true } }], later);
      expect((await store.debug.snapshot()).messages[0]!.inInbox).toBe(true);
    });

    it.each(["reset", "move", "copy"] as const)("location evidence is fenced at commit after a %s and reopen", async (change) => {
      let store = await harness.open(); stores.push(store);
      const [, a] = await withAccounts(store, 2);
      await ingest(store, [msg({ accountId: a!, providerMsgId: "locator", locations: [{ mailbox: "INBOX", uidvalidity: 10, uid: 1, flags: [] }] })]);
      await observe(store, a!);
      const threadId = await threadOf(store, "locator");
      const action = await store.threads.act({ threadIds: [threadId], action: "star", signal: null, now: 1 });
      const [op] = await store.ops.claimReady(2, 20);
      await store.ops.complete(op!.id, undefined, 3);
      const id = (await store.debug.snapshot()).messages[0]!.id;
      const fresh = (await observe(store, a!))!;
      const captured = await store.providerStore(a!).locations.of([id]);
      if (change === "reset") await store.providerStore(a!).locations.upsert(id, "INBOX", 11, 1, ["\\Flagged"]);
      else {
        const locations = store.providerStore(a!).locations;
        const owner = await locations.dispatch([id], captured, async (token) => token!, [id]);
        await locations.mappedMove(captured, "Projects", 20, [{ messageId: id, uid: 2 }], change === "copy", captured, owner);
      }
      store = await harness.reopen(store); stores.push(store);
      const stale = { messageId: id, expectedProviderMsgId: "locator", expectedImapLocations: captured, flags: { isStarred: false, isRead: true, isSent: true } };
      await store.sync.updateFlags(a!, [stale], fresh);
      expect((await store.debug.snapshot()).messages[0]).toMatchObject({ isStarred: true, isRead: false });
      expect((await store.providerStore(a!).pendingFlagSnapshots({ limit: 50 })).items).toEqual([{ id, providerMsgId: "locator" }]);
      expect((await store.ops.get(action.opIds[0]!))?.state).toBe("succeeded");
      const current = await store.providerStore(a!).locations.of([id]);
      await store.sync.updateFlags(a!, [{ ...stale, expectedImapLocations: current }], (await observe(store, a!))!);
      expect((await store.debug.snapshot()).messages[0]).toMatchObject({ isStarred: false, isRead: true });
      expect((await store.providerStore(a!).pendingFlagSnapshots({ limit: 50 })).items).toEqual([]);
    });

    it("an incomplete derived change records durable targeted work without retiring observed intent", async () => {
      let store = await harness.open(); stores.push(store);
      const [other, a] = await withAccounts(store);
      await ingest(store, [msg({ accountId: a!, providerMsgId: "partial", locations: [{ mailbox: "INBOX", uidvalidity: 1, uid: 1, flags: [] }] })]);
      await observe(store, a!);
      await store.threads.act({ threadIds: [await threadOf(store, "partial")], action: "star", signal: null, now: 1 });
      const [op] = await store.ops.claimReady(2, 1);
      await store.ops.complete(op!.id, undefined, 3);
      const id = (await store.debug.snapshot()).messages[0]!.id;
      await store.sync.updateFlags(a!, [{ messageId: id, expectedProviderMsgId: "partial", flags: { isStarred: true } }], (await observe(store, a!))!);
      expect((await store.providerStore(a!).pendingFlagSnapshots({ limit: 50 })).items).toEqual([]);
      const foreign = await store.sync.updateFlags(other!, [{ messageId: id, flags: { isStarred: false, isRead: true } }]);
      expect(foreign.touched).toEqual([]);
      expect(foreign.flagReconcileAccounts).toBeUndefined();
      expect((await store.providerStore(a!).pendingFlagSnapshots({ limit: 50 })).items).toEqual([]);
      const mismatch = await store.sync.updateFlags(a!, [{ messageId: id, expectedProviderMsgId: "replacement", flags: { isStarred: false, isRead: true } }]);
      expect(mismatch.touched).toEqual([]);
      expect((await store.providerStore(a!).pendingFlagSnapshots({ limit: 50 })).items).toEqual([]);
      const partial = await store.sync.updateFlags(a!, [{ messageId: id, expectedProviderMsgId: "partial", flags: { isStarred: false, isRead: true } }]);
      expect(partial.flagReconcileAccounts).toEqual([a]);
      expect((await store.debug.snapshot()).messages[0]).toMatchObject({ isStarred: true, isRead: true });
      store = await harness.reopen(store); stores.push(store);
      expect((await store.providerStore(a!).pendingFlagSnapshots({ limit: 50 })).items).toEqual([{ id, providerMsgId: "partial" }]);
      await store.sync.updateFlags(a!, [{ messageId: id, expectedProviderMsgId: "partial", expectedImapLocations: await store.providerStore(a!).locations.of([id]), flags: { isStarred: false } }], (await observe(store, a!))!);
      expect((await store.debug.snapshot()).messages[0]!.isStarred).toBe(false);
      expect((await store.providerStore(a!).pendingFlagSnapshots({ limit: 50 })).items).toEqual([]);
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

    it("partial unknown retry releases superseded queue targets for fresh independent observations", async () => {
      const store = await harness.open(); stores.push(store);
      const [a] = await withAccounts(store, 1);
      await ingest(store, [msg({ accountId: a!, providerMsgId: "superseded" }), msg({ accountId: a!, providerMsgId: "retry" })]);
      await observe(store, a!);
      const firstThread = await threadOf(store, "superseded"), secondThread = await threadOf(store, "retry");
      await store.threads.act({ threadIds: [firstThread, secondThread], action: "markRead", signal: null, now: 1 });
      const [unknown] = await store.ops.claimReady(2, 20);
      await store.ops.markUnknown(unknown!.id, "uncertain", 3);
      await store.threads.act({ threadIds: [firstThread], action: "markUnread", signal: null, now: 4 });
      const [newer] = await store.ops.claimReady(5, 20);
      await store.ops.complete(newer!.id, undefined, 6);
      await store.ops.resolveUnknown(unknown!.id, "retry", 7);
      const snapshot = await store.debug.snapshot();
      const first = snapshot.messages.find((message) => message.providerMsgId === "superseded")!;
      const second = snapshot.messages.find((message) => message.providerMsgId === "retry")!;
      expect(JSON.parse((await store.ops.claimReady(8, 20))[0]!.target_json).messageIds).toEqual([second.id]);
      const fresh = (await observe(store, a!))!;
      await store.sync.updateFlags(a!, [{ messageId: first.id, expectedProviderMsgId: "superseded", flags: { isRead: true } }], fresh);
      expect((await store.debug.snapshot()).messages.find((message) => message.id === first.id)!.isRead).toBe(true);
    });

    it.each(["read", "star"] as const)("an explicit no-op %s reaffirmation prevents replaying conflicting uncertain work", async (field) => {
      let store = await harness.open(); stores.push(store);
      const [a] = await withAccounts(store, 1);
      await ingest(store, [msg({ accountId: a!, providerMsgId: "reaffirm", isRead: true, isStarred: true })]);
      const threadId = await threadOf(store, "reaffirm");
      await observe(store, a!);
      await store.threads.act({ threadIds: [threadId], action: field === "read" ? "markUnread" : "unstar", signal: null, now: 1 });
      const [unknown] = await store.ops.claimReady(2, 20);
      await store.ops.markUnknown(unknown!.id, "uncertain", 3);
      const fresh = (await observe(store, a!))!;
      const id = (await store.debug.snapshot()).messages[0]!.id;
      await store.sync.updateFlags(a!, [{ messageId: id, expectedProviderMsgId: "reaffirm", flags: { isRead: true, isStarred: true } }], fresh);
      const reaffirmed = await store.threads.act({ threadIds: [threadId], action: field === "read" ? "markRead" : "star", signal: null, now: 4 });
      expect(reaffirmed.opIds).toEqual([]);
      expect(reaffirmed.before).toEqual([]);
      expect(reaffirmed.flagReconcileAccounts).toEqual([a]);
      store = await harness.reopen(store); stores.push(store);
      await expect(store.ops.resolveUnknown(unknown!.id, "retry", 5)).rejects.toMatchObject({ code: "STALE" });
      expect((await store.debug.snapshot()).messages[0]).toMatchObject({ isRead: true, isStarred: true });
    });

    it("ignores active effects on no-op reaffirmation and isolates account cascades", async () => {
      const store = await harness.open(); stores.push(store);
      const [a, b] = await withAccounts(store, 2);
      await ingest(store, [msg({ accountId: a!, providerMsgId: "active-a" }), msg({ accountId: b!, providerMsgId: "active-b" })]);
      await observe(store, a!); await observe(store, b!);
      const snapshot = await store.debug.snapshot();
      const first = snapshot.messages.find((message) => message.providerMsgId === "active-a")!;
      const second = snapshot.messages.find((message) => message.providerMsgId === "active-b")!;
      await store.threads.act({ threadIds: [first.threadId], action: "markRead", signal: null, now: 1 });
      await store.threads.act({ threadIds: [second.threadId], action: "markRead", signal: null, now: 2 });
      const before = (await observe(store, a!))!;
      expect((await store.threads.act({ threadIds: [first.threadId], action: "markRead", signal: null, now: 3 })).flagReconcileAccounts).toBeUndefined();
      expect((await observe(store, a!))!.epoch).toBe(before.epoch + 1);
      const claimed = await store.ops.claimReady(4, 10);
      const other = claimed.find((op) => op.account_id === b)!;
      await store.ops.markUnknown(other.id, "uncertain", 5);
      await store.sync.remove([first.id]);
      await expect(store.ops.resolveUnknown(other.id, "retry", 6)).resolves.toBeDefined();
      expect((await store.debug.snapshot()).messages.find((message) => message.id === second.id)?.isRead).toBe(true);
    });

    it("does not reaffirm one field when the whole location action differs", async () => {
      const store = await harness.open(); stores.push(store);
      const [a] = await withAccounts(store, 1);
      await ingest(store, [msg({ accountId: a!, providerMsgId: "location-guard" })]);
      await observe(store, a!);
      const thread = await threadOf(store, "location-guard");
      await store.threads.act({ threadIds: [thread], action: "spam", signal: null, now: 1 });
      const [op] = await store.ops.claimReady(2, 10);
      await store.ops.markUnknown(op!.id, "uncertain", 3);
      const id = (await store.debug.snapshot()).messages[0]!.id;
      const fresh = (await observe(store, a!))!;
      await store.sync.updateFlags(a!, [{ messageId: id, expectedProviderMsgId: "location-guard", flags: { isSpam: false, inInbox: false } }], fresh);
      const result = await store.threads.act({ threadIds: [thread], action: "notSpam", signal: null, now: 4 });
      expect(result.flagReconcileAccounts).toBeUndefined();
      expect((await observe(store, a!))!.epoch).toBe(fresh.epoch + 1);
      await expect(store.ops.resolveUnknown(op!.id, "retry", 5)).resolves.toBeDefined();
    });

    it.each(["success", "failure"] as const)("representable Undo tracks each field's final step through final archive %s", async (outcome) => {
      let store = await harness.open(); stores.push(store);
      const [a] = await withAccounts(store, 1);
      await ingest(store, [msg({ accountId: a!, providerMsgId: "undo-place", inInbox: false })]);
      await observe(store, a!);
      const trashed = await store.threads.act({ threadIds: [await threadOf(store, "undo-place")], action: "trash", signal: null, now: 1 });
      await store.ops.claimReady(2, 20);
      await store.ops.complete(trashed.opIds[0]!, undefined, 3);
      const restored = await store.threads.restore({ messages: trashed.before, now: 4 });
      const [first] = await store.ops.claimReady(5, 20);
      expect(first!.kind).toBe("moveToInbox");
      await store.ops.complete(first!.id, undefined, 6);
      const intermediate = (await observe(store, a!))!;
      const id = (await store.debug.snapshot()).messages[0]!.id;
      await store.sync.updateFlags(a!, [{ messageId: id, expectedProviderMsgId: "undo-place", flags: { inInbox: true, isTrash: false, isSpam: false, isStarred: true } }], intermediate);
      expect((await store.debug.snapshot()).messages[0]).toMatchObject({ inInbox: false, isTrash: false, isSpam: false, isStarred: true });
      store = await harness.reopen(store); stores.push(store);
      const [last] = await store.ops.claimReady(7, 20);
      expect(last!.id).toBe(restored.opIds[1]);
      expect(last!.kind).toBe("archive");
      if (outcome === "success") await store.ops.complete(last!.id, undefined, 8);
      else await store.ops.fail(last!.id, "synthetic archive refusal", false, 8);
      await store.sync.updateFlags(a!, [{ messageId: id, expectedProviderMsgId: "undo-place", flags: { inInbox: true } }], intermediate);
      expect((await store.debug.snapshot()).messages[0]!.inInbox).toBe(false);
      const fresh = (await observe(store, a!))!;
      await store.sync.updateFlags(a!, [{ messageId: id, expectedProviderMsgId: "undo-place", flags: { inInbox: true, isTrash: false, isSpam: false } }], fresh);
      expect((await store.debug.snapshot()).messages[0]).toMatchObject({ inInbox: true, isTrash: false, isSpam: false });
    });

    it.each([false, true])("final Undo archive retry remains eligible after repeat=%s", async (repeat) => {
      let store = await harness.open(); stores.push(store);
      const [a] = await withAccounts(store, 1);
      await ingest(store, [msg({ accountId: a!, providerMsgId: "undo-final-retry", inInbox: false })]);
      await observe(store, a!);
      const thread = await threadOf(store, "undo-final-retry");
      const trashed = await store.threads.act({ threadIds: [thread], action: "trash", signal: null, now: 1 });
      await store.ops.claimReady(2, 20);
      await store.ops.complete(trashed.opIds[0]!, undefined, 3);
      const restored = await store.threads.restore({ messages: trashed.before, now: 4 });
      expect(restored.opIds).toHaveLength(2);
      const [move] = await store.ops.claimReady(5, 20);
      expect(move!.id).toBe(restored.opIds[0]);
      await store.ops.markUnknown(move!.id, "uncertain", 6);
      const [archive] = await store.ops.claimReady(7, 20);
      expect(archive!.id).toBe(restored.opIds[1]);
      await store.ops.markUnknown(archive!.id, "uncertain", 8);
      await expect(store.ops.resolveUnknown(move!.id, "retry", 9)).rejects.toMatchObject({ code: "STALE" });
      const before = (await observe(store, a!))!;
      if (repeat) {
        const result = await store.threads.act({ threadIds: [thread], action: "archive", signal: null, now: 10 });
        expect(result.opIds).toEqual([]);
        expect(result.flagReconcileAccounts).toBeUndefined();
      }
      const after = (await observe(store, a!))!;
      expect(after.epoch).toBe(before.epoch + 1);
      store = await harness.reopen(store); stores.push(store);
      await expect(store.ops.resolveUnknown(archive!.id, "retry", 11)).resolves.toBeDefined();
      expect((await store.debug.snapshot()).messages[0]).toMatchObject({ inInbox: false, isTrash: false, isSpam: false });
    });

    it("uncertain intermediate Undo steps cannot replay over their final location intent", async () => {
      const store = await harness.open(); stores.push(store);
      const [a] = await withAccounts(store, 1);
      await ingest(store, [msg({ accountId: a!, providerMsgId: "undo-uncertain", inInbox: false })]);
      await observe(store, a!);
      const trashed = await store.threads.act({ threadIds: [await threadOf(store, "undo-uncertain")], action: "trash", signal: null, now: 1 });
      await store.ops.claimReady(2, 20);
      await store.ops.complete(trashed.opIds[0]!, undefined, 3);
      await store.threads.restore({ messages: trashed.before, now: 4 });
      const [first] = await store.ops.claimReady(5, 20);
      await store.ops.markUnknown(first!.id, "synthetic ambiguous move", 6);
      await expect(store.ops.resolveUnknown(first!.id, "retry", 7)).rejects.toMatchObject({ code: "STALE" });
      expect((await store.debug.snapshot()).messages[0]).toMatchObject({ inInbox: false, isTrash: false, isSpam: false });
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

    it("discarding uncertain flag work commits a snapshot wakeup and ignores stale terminal callbacks", async () => {
      let store = await harness.open(); stores.push(store);
      const [a] = await withAccounts(store, 1);
      await ingest(store, [msg({ accountId: a!, providerMsgId: "discard" })]);
      await observe(store, a!);
      await store.threads.act({ threadIds: [await threadOf(store, "discard")], action: "markRead", signal: null, now: 1 });
      const [op] = await store.ops.claimReady(2, 20);
      await store.ops.markUnknown(op!.id, "uncertain", 3);
      const beforeDiscard = (await observe(store, a!))!;
      const discarded = await store.ops.resolveUnknown(op!.id, "discard", 4);
      expect(discarded.flagReconcileAccounts).toEqual([a]);
      store = await harness.reopen(store); stores.push(store);
      const id = (await store.debug.snapshot()).messages[0]!.id;
      await store.sync.updateFlags(a!, [{ messageId: id, expectedProviderMsgId: "discard", flags: { isRead: false } }], beforeDiscard);
      expect((await store.debug.snapshot()).messages[0]!.isRead).toBe(true);
      const fresh = (await observe(store, a!))!;
      await store.sync.updateFlags(a!, [{ messageId: id, expectedProviderMsgId: "discard", flags: { isRead: false } }], fresh);
      await store.ops.complete(op!.id, undefined, 5);
      expect((await store.ops.get(op!.id))?.state).toBe("failed");
      expect((await store.providerStore(a!).pendingFlagSnapshots({ limit: 50 })).items).toEqual([]);
      expect(await store.ops.claimReady(6, 20)).toEqual([]);
      expect((await store.debug.snapshot()).messages[0]!.isRead).toBe(false);
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

    it.each(["markRead", "star"] as const)("saved %s Undo invalidates a conflicting parked retry after remote reversal", async (action) => {
      let store = await harness.open(); stores.push(store);
      const [a] = await withAccounts(store, 1);
      await ingest(store, [msg({ accountId: a!, providerMsgId: "undo-park" })]);
      await observe(store, a!);
      const changed = await store.threads.act({ threadIds: [await threadOf(store, "undo-park")], action, signal: null, now: 1 });
      const [op] = await store.ops.claimReady(2, 10);
      await store.ops.markUnknown(op!.id, "uncertain", 3);
      const id = (await store.debug.snapshot()).messages[0]!.id;
      const fresh = (await observe(store, a!))!;
      await store.sync.updateFlags(a!, [{ messageId: id, expectedProviderMsgId: "undo-park", flags: { isRead: false, isStarred: false } }], fresh);
      const undone = await store.threads.restore({ messages: changed.before, now: 4 });
      expect(undone.opIds).toEqual([]);
      expect(undone.flagReconcileAccounts).toEqual([a]);
      store = await harness.reopen(store); stores.push(store);
      await expect(store.ops.resolveUnknown(op!.id, "retry", 5)).rejects.toMatchObject({ code: "STALE" });
      expect((await store.debug.snapshot()).messages[0]).toMatchObject({ isRead: false, isStarred: false });
    });

    it("shares the saved Undo generation with actual restore work without expanding fields or targets", async () => {
      const store = await harness.open(); stores.push(store);
      const [a] = await withAccounts(store, 1);
      await ingest(store, ["one", "two", "other"].map((providerMsgId) => msg({ accountId: a!, providerMsgId })));
      await observe(store, a!);
      const one = await threadOf(store, "one"), two = await threadOf(store, "two"), other = await threadOf(store, "other");
      const changed = await store.threads.act({ threadIds: [one, two], action: "markRead", signal: null, now: 1 });
      const [parked] = await store.ops.claimReady(2, 10);
      await store.ops.markUnknown(parked!.id, "uncertain", 3);
      await store.threads.act({ threadIds: [other], action: "star", signal: null, now: 4 });
      const [unrelated] = await store.ops.claimReady(5, 10);
      await store.ops.markUnknown(unrelated!.id, "uncertain", 6);
      const id = (await store.debug.snapshot()).messages.find((m) => m.providerMsgId === "one")!.id;
      const before = (await observe(store, a!))!;
      await store.sync.updateFlags(a!, [{ messageId: id, expectedProviderMsgId: "one", flags: { isRead: false } }], before);
      const restored = await store.threads.restore({ messages: changed.before, now: 7 });
      expect(restored.opIds).toHaveLength(1);
      expect(restored.flagReconcileAccounts).toEqual([a]);
      const after = (await observe(store, a!))!;
      expect(after.epoch).toBe(before.epoch + 2);
      await store.sync.updateFlags(a!, [{ messageId: id, expectedProviderMsgId: "one", flags: { isStarred: true } }], after);
      expect((await store.debug.snapshot()).messages.find((m) => m.id === id)!.isStarred).toBe(true);
      await expect(store.ops.resolveUnknown(unrelated!.id, "retry", 8)).resolves.toBeDefined();
    });

    it("reaffirms a current legacy zero-generation parked effect after a fresh reversal", async () => {
      let store = await harness.open(); stores.push(store);
      const [a] = await withAccounts(store, 1);
      await ingest(store, [msg({ accountId: a!, providerMsgId: "legacy-current" })]);
      const thread = await threadOf(store, "legacy-current");
      await store.threads.act({ threadIds: [thread], action: "markRead", signal: null, now: 1 });
      const [op] = await store.ops.claimReady(2, 10);
      await store.ops.markUnknown(op!.id, "uncertain", 3);
      const id = (await store.debug.snapshot()).messages[0]!.id;
      const fresh = (await observe(store, a!))!;
      await store.sync.updateFlags(a!, [{ messageId: id, expectedProviderMsgId: "legacy-current", flags: { isRead: false } }], fresh);
      expect((await store.threads.act({ threadIds: [thread], action: "markUnread", signal: null, now: 4 })).flagReconcileAccounts).toEqual([a]);
      store = await harness.reopen(store); stores.push(store);
      await expect(store.ops.resolveUnknown(op!.id, "retry", 5)).rejects.toMatchObject({ code: "STALE" });
    });

    it("does not reaffirm an already stale legacy unknown binding", async () => {
      const store = await harness.open(); stores.push(store);
      const [a] = await withAccounts(store, 1);
      await ingest(store, [msg({ accountId: a!, providerMsgId: "legacy-stale" })]);
      const changed = await store.threads.act({ threadIds: [await threadOf(store, "legacy-stale")], action: "markRead", signal: null, now: 1 });
      const [op] = await store.ops.claimReady(2, 10);
      await store.ops.markUnknown(op!.id, "uncertain", 3);
      const id = (await store.debug.snapshot()).messages[0]!.id;
      await store.sync.updateFlags(a!, [{ messageId: id, flags: { isRead: false } }]);
      const before = (await observe(store, a!))!;
      const restored = await store.threads.restore({ messages: changed.before, now: 4 });
      expect(restored.opIds).toEqual([]);
      expect(restored.flagReconcileAccounts).toBeUndefined();
      expect((await observe(store, a!))!.epoch).toBe(before.epoch + 1);
      await expect(store.ops.resolveUnknown(op!.id, "retry", 5)).rejects.toMatchObject({ code: "STALE" });
    });

    it("resumes a partial legacy header and a later header across reopen", async () => {
      let store = await harness.open(); stores.push(store);
      const [a] = await withAccounts(store, 1);
      await ingest(store, Array.from({ length: 130 }, (_, i) => msg({ accountId: a!, providerMsgId: `partial-${i}` })));
      const threads = (await store.debug.snapshot()).threads;
      await store.threads.act({ threadIds: threads.slice(0, 129).map((t) => t.id), action: "archive", signal: null, now: 1 });
      await store.threads.act({ threadIds: [threads[129]!.id], action: "archive", signal: null, now: 1 });
      await observe(store, a!);
      for (const op of await store.ops.claimReady(2, 10)) await store.ops.complete(op.id, undefined, 3);
      store = await harness.reopen(store); stores.push(store);
      let afterMessageId = 0, count = 0;
      for (;;) {
        const page = await store.providerStore(a!).pendingFlagSnapshots({ limit: 50, afterMessageId });
        count += page.items.length;
        if (!page.hasMore) break;
        afterMessageId = page.items[page.items.length - 1]!.id;
      }
      expect(count).toBe(130);
      const messages = (await store.debug.snapshot()).messages;
      await store.sync.updateFlags(a!, messages.map((m) => ({ messageId: m.id, flags: { inInbox: true } })));
      expect((await store.debug.snapshot()).messages.every((m) => !m.inInbox)).toBe(true);
    });

    it.each(["complete", "fail", "unknown"] as const)("first activation serializes a concurrent legacy %s before deleting its synthesis source", async (outcome) => {
      let store = await harness.open(); stores.push(store);
      const [a] = await withAccounts(store, 1);
      await ingest(store, [msg({ accountId: a!, providerMsgId: "first-activation" })]);
      await store.threads.act({ threadIds: [await threadOf(store, "first-activation")], action: "archive", signal: null, now: 1 });
      const [op] = await store.ops.claimReady(2, 20);
      const activation = observe(store, a!);
      const settled = outcome === "complete" ? store.ops.complete(op!.id, undefined, 3) : outcome === "fail" ? store.ops.fail(op!.id, "synthetic terminal refusal", false, 3) : store.ops.markUnknown(op!.id, "synthetic uncertainty", 3);
      await Promise.all([activation, settled]);
      store = await harness.reopen(store); stores.push(store);
      const id = (await store.debug.snapshot()).messages[0]!.id;
      expect((await store.providerStore(a!).pendingFlagSnapshots({ limit: 1 })).items).toEqual([{ id, providerMsgId: "first-activation" }]);
      await store.sync.updateFlags(a!, [{ messageId: id, flags: { inInbox: true } }]);
      expect((await store.debug.snapshot()).messages[0]!.inInbox).toBe(false);
      const fresh = (await observe(store, a!))!;
      await store.sync.updateFlags(a!, [{ messageId: id, expectedProviderMsgId: "first-activation", flags: { inInbox: true } }], fresh);
      expect((await store.debug.snapshot()).messages[0]!.inInbox).toBe(true);
    });

    it("a legacy acknowledgement after cancelled INIT retains fresh snapshot ownership", async () => {
      const store = await harness.open(); stores.push(store);
      const [a] = await withAccounts(store, 1);
      await ingest(store, [msg({ accountId: a!, providerMsgId: "legacy-ack" })]);
      await store.threads.act({ threadIds: [await threadOf(store, "legacy-ack")], action: "archive", signal: null, now: 1 });
      const [op] = await store.ops.claimReady(2, 20);
      let reads = 0;
      const cancelled = new Error("synthetic initialization cancellation");
      await expect(store.sync.beginObservation(a!, { authoritativeFlags: true, signal: { get aborted() { return ++reads > 1; }, reason: cancelled } })).rejects.toBe(cancelled);
      await store.ops.complete(op!.id, undefined, 3);
      await observe(store, a!);
      const id = (await store.debug.snapshot()).messages[0]!.id;
      expect((await store.providerStore(a!).pendingFlagSnapshots({ limit: 50 })).items).toEqual([{ id, providerMsgId: "legacy-ack" }]);
      await store.sync.updateFlags(a!, [{ messageId: id, flags: { inInbox: true } }]);
      expect((await store.debug.snapshot()).messages[0]!.inInbox).toBe(false);
    });

    it("READY recovery waits for effect metadata before pruning an older running target", async () => {
      let store = await harness.open(); stores.push(store);
      const [a] = await withAccounts(store, 1);
      await ingest(store, [msg({ accountId: a!, providerMsgId: "recover" })]);
      const threadId = await threadOf(store, "recover");
      await observe(store, a!);
      await store.threads.act({ threadIds: [threadId], action: "markRead", signal: null, now: 1 });
      await store.ops.claimReady(2, 20);
      const newer = await store.threads.act({ threadIds: [threadId], action: "markUnread", signal: null, now: 3 });
      store = await harness.reopen(store); stores.push(store);
      await store.ops.recover(4);
      expect((await store.ops.claimReady(5, 20)).map((op) => op.id)).toEqual(newer.opIds);
      await store.ops.complete(newer.opIds[0]!, undefined, 6);
      const id = (await store.debug.snapshot()).messages[0]!.id;
      const fresh = await observe(store, a!);
      await store.sync.updateFlags(a!, [{ messageId: id, expectedProviderMsgId: "recover", flags: { isRead: true } }], fresh!);
      expect((await store.debug.snapshot()).messages[0]!.isRead).toBe(true);
      expect((await store.providerStore(a!).pendingFlagSnapshots({ limit: 50 })).items).toEqual([]);
    });
  });
}
