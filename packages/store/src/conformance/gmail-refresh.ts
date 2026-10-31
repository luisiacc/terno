import { afterEach, describe, expect, it } from "vitest";
import type { MailStore } from "../mail-store";
import { ingest, msg } from "./fixtures";
import type { StoreHarness } from "./store";

export function defineGmailRefreshConformance(name: string, harness: StoreHarness): void {
  describe(`${name} current-binding Gmail refresh`, () => {
    const stores: MailStore[] = [];
    afterEach(async () => { for (const store of stores.splice(0)) if (store.isOpen) await store.close(); });
    const setup = async () => {
      const store = await harness.open(); stores.push(store);
      const { account } = await store.accounts.create({ kind: "gmail", email: "synthetic@example.test", displayName: "Synthetic", color: "indigo", now: 1 });
      await store.sync.beginObservation(account.id, { authoritativeFlags: true });
      await store.accounts.setCursor(account.id, { historyId: "100" });
      return { store, accountId: account.id };
    };
    const pending = async (store: MailStore, accountId: number) => (await store.providerStore(accountId).pendingFlagSnapshots({ limit: 50 })).items;
    it("retains a newer admission across stale observation, reopen and conditional acknowledgment", async () => {
      let { store, accountId } = await setup();
      const original = msg({ accountId, providerMsgId: "opaque:/+?=long-identity", attachments: [], gmailLabels: ["INBOX", "UNREAD"] });
      await ingest(store, [original]);
      const id = (await store.debug.snapshot()).messages[0]!.id;
      const old = (await store.sync.beginObservation(accountId, { authoritativeFlags: true }))!;
      await ingest(store, [original]);
      await store.sync.updateFlags(accountId, [{ messageId: id, expectedProviderMsgId: original.providerMsgId!, flags: { isRead: true, isStarred: true, inInbox: false, isTrash: false, isSpam: false }, gmailLabels: [] }], old);
      expect(await pending(store, accountId)).toEqual([{ id, providerMsgId: original.providerMsgId }]);
      store = await harness.reopen(store); stores.push(store);
      expect(await pending(store, accountId)).toEqual([{ id, providerMsgId: original.providerMsgId }]);
      const fresh = (await store.sync.beginObservation(accountId, { authoritativeFlags: true }))!;
      await store.sync.updateFlags(accountId, [{ messageId: id, expectedProviderMsgId: "wrong-binding", flags: { isRead: true, isStarred: true, inInbox: false, isTrash: false, isSpam: false } }], fresh);
      expect(await pending(store, accountId)).toHaveLength(1);
      await store.sync.updateFlags(accountId, [{ messageId: id, expectedProviderMsgId: original.providerMsgId!, flags: { isRead: true, isStarred: true, inInbox: false, isTrash: false, isSpam: false }, gmailLabels: [] }], fresh);
      expect(await pending(store, accountId)).toEqual([]);
      expect((await store.debug.snapshot()).messages[0]).toMatchObject({ id, providerMsgId: original.providerMsgId, bodyText: original.bodyText, isRead: true, isStarred: true, inInbox: false });
    });
    it("does not invalidate a fresh provider admission, and deletion prunes an untrusted admission", async () => {
      const { store, accountId } = await setup();
      const observation = (await store.sync.beginObservation(accountId, { authoritativeFlags: true }))!;
      const original = msg({ accountId, providerMsgId: "fresh", attachments: [] });
      await store.sync.ingest([original], { applyFilters: false, now: 2, classifier: null, observation });
      expect(await pending(store, accountId)).toEqual([]);
      await ingest(store, [msg({ ...original, providerMsgId: "untrusted", rfcMessageId: "other@example.test" })]);
      const owed = (await pending(store, accountId))[0]!;
      expect(owed?.providerMsgId).toBe("untrusted");
      const old = (await store.sync.beginObservation(accountId, { authoritativeFlags: true }))!;
      await store.sync.remove([owed.id]);
      await store.sync.updateFlags(accountId, [{ messageId: owed.id, expectedProviderMsgId: "untrusted", flags: { inInbox: true } }], old);
      expect(await pending(store, accountId)).toEqual([]);
      expect((await store.debug.snapshot()).messages.map((row) => row.providerMsgId)).toEqual(["fresh"]);
    });
    it("does not treat another account's observation as fresh admission evidence", async () => {
      const { store, accountId } = await setup();
      const { account } = await store.accounts.create({ kind: "gmail", email: "peer@example.test", displayName: "Peer", color: "indigo", now: 2 });
      const peerObservation = (await store.sync.beginObservation(account.id, { authoritativeFlags: true }))!;
      await store.sync.ingest([msg({ accountId, providerMsgId: "cross-account", attachments: [] })], { applyFilters: false, now: 3, classifier: null, observation: peerObservation });
      expect((await pending(store, accountId)).map((row) => row.providerMsgId)).toEqual(["cross-account"]);
      expect(await pending(store, account.id)).toEqual([]);
    });
    it("cannot acknowledge a replacement account with an old account observation", async () => {
      const { store, accountId } = await setup();
      const old = (await store.sync.beginObservation(accountId, { authoritativeFlags: true }))!;
      await store.accounts.remove(accountId);
      const { account } = await store.accounts.create({ kind: "gmail", email: "synthetic@example.test", displayName: "Replacement", color: "indigo", now: 2 });
      expect(account.id).not.toBe(accountId);
      await store.sync.beginObservation(account.id, { authoritativeFlags: true });
      await store.accounts.setCursor(account.id, { historyId: "100" });
      await ingest(store, [msg({ accountId: account.id, providerMsgId: "same-remote-key", attachments: [] })]);
      const row = (await store.debug.snapshot()).messages[0]!;
      await store.sync.updateFlags(account.id, [{ messageId: row.id, expectedProviderMsgId: "same-remote-key", flags: { isRead: true, isStarred: false, inInbox: false, isTrash: false, isSpam: false } }], old);
      expect(await pending(store, accountId)).toEqual([]);
      expect(await pending(store, account.id)).toEqual([{ id: row.id, providerMsgId: "same-remote-key" }]);
    });
    it("promotes a sent local identity with a durable current-binding obligation", async () => {
      const { store, accountId } = await setup();
      const send = await store.compose.queueSend({ accountId, to: [{ name: "", email: "recipient@example.test" }], cc: [], bcc: [], subject: "Synthetic", bodyText: "Exact sent body", recordReply: false, now: 2 });
      const before = (await store.debug.snapshot()).messages[0]!;
      const old = (await store.sync.beginObservation(accountId, { authoritativeFlags: true }))!;
      const [op] = await store.ops.claimReady(100_000, 10); expect(op?.id).toBe(send.opId);
      const providerId = "opaque:/+?=" + "x".repeat(2048);
      const completed = await store.ops.complete(op!.id, { providerMsgId: providerId }, 100_001);
      expect(completed.flagReconcileAccounts).toEqual([accountId]);
      expect(await pending(store, accountId)).toEqual([{ id: before.id, providerMsgId: providerId }]);
      await store.sync.updateFlags(accountId, [{ messageId: before.id, expectedProviderMsgId: providerId, flags: { isRead: true, isStarred: false, inInbox: false, isSpam: false, isTrash: false } }], old);
      expect(await pending(store, accountId)).toHaveLength(1);
      expect((await store.debug.snapshot()).messages[0]).toMatchObject({ id: before.id, providerMsgId: providerId, bodyText: "Exact sent body" });
    });
    it.each(["ingest", "send"] as const)("binds a flag action queued before local identity promotion through %s", async (source) => {
      const { store, accountId } = await setup();
      const local = msg({ accountId, providerMsgId: "local:promotion", rfcMessageId: "promotion@example.test", isStarred: false, attachments: [] });
      const send = source === "send" ? await store.compose.queueSend({ accountId, to: [{ name: "", email: "recipient@example.test" }], cc: [], bcc: [], subject: "Synthetic", bodyText: "Exact sent body", recordReply: false, now: 2 }) : undefined;
      if (!send) await ingest(store, [local]);
      const row = (await store.debug.snapshot()).messages[0]!;
      const action = await store.threads.act({ threadIds: [row.threadId], action: "star", signal: null, now: 3 });
      const ready = send ? await store.ops.claimReady(100_000, 10) : undefined;
      if (send) await store.ops.complete(send.opId, { providerMsgId: "promoted" }, 100_001);
      else await ingest(store, [{ ...local, providerMsgId: "promoted" }]);
      const captured = (await store.sync.beginObservation(accountId, { authoritativeFlags: true }))!;
      const op = send ? ready!.find((candidate) => candidate.id === action.opIds[0]) : (await store.ops.claimReady(4, 10))[0];
      expect(op?.id).toBe(action.opIds[0]);
      await store.ops.complete(op!.id, undefined, 100_002);
      await store.sync.updateFlags(accountId, [{ messageId: row.id, expectedProviderMsgId: "promoted", flags: { isRead: false, isStarred: false, inInbox: true, isTrash: false, isSpam: false } }], captured);
      expect((await store.debug.snapshot()).messages[0]).toMatchObject({ id: row.id, providerMsgId: "promoted", isStarred: true, bodyText: row.bodyText });
      expect((await pending(store, accountId)).map((item) => item.id)).toEqual([row.id]);
      const fresh = (await store.sync.beginObservation(accountId, { authoritativeFlags: true }))!;
      await store.sync.updateFlags(accountId, [{ messageId: row.id, expectedProviderMsgId: "promoted", flags: { isRead: false, isStarred: true, inInbox: true, isTrash: false, isSpam: false } }], fresh);
      expect(await pending(store, accountId)).toEqual([]);
    });
    it("retains current local flag intent until its operation settles", async () => {
      const { store, accountId } = await setup();
      const original = msg({ accountId, providerMsgId: "intent", attachments: [], isRead: false });
      await ingest(store, [original]);
      const row = (await store.debug.snapshot()).messages[0]!;
      const action = await store.threads.act({ threadIds: [row.threadId], action: "markRead", now: 3, signal: null });
      await ingest(store, [original]);
      const observation = (await store.sync.beginObservation(accountId, { authoritativeFlags: true }))!;
      await store.sync.updateFlags(accountId, [{ messageId: row.id, expectedProviderMsgId: "intent", flags: { isRead: false, isStarred: false, inInbox: true, isTrash: false, isSpam: false } }], observation);
      expect((await store.debug.snapshot()).messages[0]!.isRead).toBe(true);
      const [op] = await store.ops.claimReady(4, 10); expect(op?.id).toBe(action.opIds[0]);
      await store.ops.complete(op!.id, undefined, 5);
      expect(await pending(store, accountId)).toHaveLength(1);
    });
  });
}
