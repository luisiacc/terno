import { afterEach, describe, expect, it } from "vitest";
import type { ThreadAction } from "@terno/core";
import type { MailStore } from "../mail-store";
import type { IncomingMessage } from "../types";
import type { StoreHarness } from "./store";
import { ingest, msg, threadOf, withAccounts } from "./fixtures";

export function defineFlagIntentConformance(name: string, harness: StoreHarness): void {
  const stores: MailStore[] = [];
  afterEach(async () => { for (const store of stores.splice(0)) if (store.isOpen) await store.close(); });
  const cases: { action: ThreadAction; initial: Partial<IncomingMessage>; desired: Partial<IncomingMessage>; remote: Partial<IncomingMessage> }[] = [
    { action: "markRead", initial: {}, desired: { isRead: true }, remote: { isStarred: true } },
    { action: "markUnread", initial: { isRead: true }, desired: { isRead: false }, remote: { isStarred: true } },
    { action: "star", initial: {}, desired: { isStarred: true }, remote: { isRead: true } },
    { action: "unstar", initial: { isStarred: true }, desired: { isStarred: false }, remote: { isRead: true } },
    { action: "archive", initial: {}, desired: { inInbox: false }, remote: { isRead: true, isStarred: true } },
    { action: "trash", initial: {}, desired: { isTrash: true, inInbox: false }, remote: { isRead: true, isStarred: true } },
    { action: "spam", initial: {}, desired: { isSpam: true, inInbox: false }, remote: { isRead: true, isStarred: true } },
    { action: "notSpam", initial: { isSpam: true, inInbox: false }, desired: { isSpam: false, inInbox: true }, remote: { isRead: true, isStarred: true } },
    { action: "moveToInbox", initial: { isTrash: true, isSpam: true, inInbox: false }, desired: { isTrash: false, isSpam: false, inInbox: true }, remote: { isRead: true, isStarred: true } },
  ];
  describe(`pending field intent: ${name}`, () => {
    it.each([false, true])("W02 saved destination queues exact Trash+Spam=%s after reopen", async (spam) => {
      let store = await harness.open(); stores.push(store);
      const [accountId, other] = await withAccounts(store);
      await ingest(store, [msg({ accountId: accountId!, providerMsgId: "saved-tuple", isRead: true, isStarred: true }), msg({ accountId: other!, providerMsgId: "sibling-tuple" })]);
      const threadId = await threadOf(store, "saved-tuple");
      for (const action of ["trash", ...(spam ? ["spam" as const] : [])] as const) {
        await store.threads.act({ threadIds: [threadId], action, signal: null, now: 1 });
        for (const op of await store.ops.claimReady(2, 20)) await store.ops.complete(op.id, undefined, 3);
      }
      const before = await store.debug.snapshot();
      const action = await store.threads.act({ threadIds: [threadId], action: "moveToInbox", signal: null, now: 4 });
      for (const op of await store.ops.claimReady(5, 20)) await store.ops.complete(op.id, undefined, 6);
      expect(action.before).toHaveLength(1);
      expect(action.before[0]).toMatchObject({ inInbox: false, isTrash: true, isSpam: spam, isRead: true, isStarred: true });
      const restore = await store.threads.restore({ messages: action.before, now: 7 });
      store = await harness.reopen(store); stores.push(store);
      const after = await store.debug.snapshot();
      expect(after.messages).toEqual(before.messages);
      const correction = after.ops.filter((op) => restore.opIds.includes(op.id));
      for (const op of correction) expect(op.messageIds).toEqual([action.before[0]!.id]);
      expect(correction.map((op) => op.kind)).toEqual(spam ? ["trash", "spam"] : ["trash"]);
      await store.debug.verify();
    });

    it("exact Trash Undo clears a secondary spam flag through reopen", async () => {
      let store = await harness.open(); stores.push(store);
      const [accountId] = await withAccounts(store);
      await ingest(store, [msg({ accountId: accountId!, providerMsgId: "target", inInbox: false, isTrash: true }), msg({ accountId: accountId!, providerMsgId: "unrelated" })]);
      const threadId = await threadOf(store, "target");
      const before = await store.debug.snapshot();
      const action = await store.threads.act({ threadIds: [threadId], action: "spam", signal: null, now: 1 });
      const restore = await store.threads.restore({ messages: action.before, now: 2 });
      expect(restore.threadIds).toEqual([threadId]);
      expect((await store.threads.restore({ messages: action.before, now: 3 })).opIds).toEqual([]);
      store = await harness.reopen(store); stores.push(store);
      const after = await store.debug.snapshot();
      expect(after.messages).toEqual(before.messages);
      expect(after.ops.filter((op) => restore.opIds.includes(op.id)).map((op) => op.kind)).toEqual(["moveToInbox", "trash"]);
      const claimed = await store.ops.claimReady(3, 20);
      expect(claimed.every((op) => JSON.stringify(JSON.parse(op.target_json)) === JSON.stringify({ messageIds: [action.before[0]!.id] }))).toBe(true);
    });

    for (const c of cases) it.each(["ingest", "flags"] as const)(`${c.action} preserves only its owned fields through %s and reopen`, async (source) => {
      let store = await harness.open(); stores.push(store);
      const [accountId] = await withAccounts(store);
      const original = msg({ accountId: accountId!, providerMsgId: "captured", ...c.initial });
      await ingest(store, [original]);
      const threadId = await threadOf(store, "captured");
      const action = await store.threads.act({ threadIds: [threadId], action: c.action, signal: null, now: 1 });
      expect(action.opIds).toHaveLength(1);
      if (source === "flags") expect((await store.ops.claimReady(2, 20)).map((op) => op.id)).toEqual(action.opIds);
      const id = (await store.debug.snapshot()).messages.find((message) => message.providerMsgId === "captured")!.id;
      const observed = { ...original, ...c.remote, isSent: true, isDraft: true, gmailLabels: ["CATEGORY_PROMOTIONS"] };
      if (source === "ingest") await ingest(store, [{ ...observed, bodyText: "Repaired complete body" }]);
      else await store.sync.updateFlags(accountId!, [{ messageId: id, flags: {
        isRead: observed.isRead, isStarred: observed.isStarred, inInbox: observed.inInbox,
        isTrash: observed.isTrash, isSpam: observed.isSpam, isSent: observed.isSent, isDraft: observed.isDraft,
      }, gmailLabels: observed.gmailLabels }]);
      store = await harness.reopen(store); stores.push(store);
      const snapshot = await store.debug.snapshot();
      expect(snapshot.messages.find((message) => message.id === id)).toMatchObject({ ...c.remote, ...c.desired, isSent: true, isDraft: true, gmailLabels: '["CATEGORY_PROMOTIONS"]' });
      expect((await store.ops.get(action.opIds[0]!))?.state).toBe(source === "flags" ? "running" : "queued");
      expect((await store.threads.get(threadId))?.messages[0]?.bodyText).toBe(source === "ingest" ? "Repaired complete body" : original.bodyText);
      await store.debug.verify();
    });

    it("repairs content and assets, applies body filters once and preserves both pending actions on replay", async () => {
      let store = await harness.open(); stores.push(store);
      const [accountId] = await withAccounts(store, 1);
      await store.filters.save({ name: "body star", enabled: true, source: "manual", rule: {
        match: "all", conditions: [{ field: "body", op: "contains", value: "repairneedle" }], actions: [{ type: "star" }],
      } }, 0);
      const original = msg({ accountId: accountId!, providerMsgId: "partial", bodyState: "partial", bodyText: "prefix" });
      await ingest(store, [original]);
      const threadId = await threadOf(store, "partial");
      const archived = await store.threads.act({ threadIds: [threadId], action: "archive", signal: null, now: 1 });
      const repaired = { ...original, bodyState: "full" as const, bodyText: "complete repairneedle", bodyHtml: "<p>complete repairneedle</p>", isRead: true,
        replyTo: [{ name: "Reply", email: "reply@example.com" }], attachments: [{ filename: "exact.dat", mime: "application/octet-stream", size: 3, bytes: new Uint8Array([0, 255, 128]) }] };
      expect((await ingest(store, [repaired], 2)).opIds).toHaveLength(1);
      expect((await ingest(store, [repaired], 3)).opIds).toEqual([]);
      store = await harness.reopen(store); stores.push(store);
      const detail = (await store.threads.get(threadId))!;
      expect(detail.thread.inInbox).toBe(false);
      expect(detail.messages[0]).toMatchObject({ isRead: true, isStarred: true, bodyState: "full", bodyText: "complete repairneedle", bodyHtml: "<p>complete repairneedle</p>", replyTo: repaired.replyTo });
      expect(await store.attachments.read(accountId!, detail.messages[0]!.attachments[0]!.assetId!, 0)).toBe("AP+A");
      expect((await store.debug.snapshot()).ops.map((op) => ({ kind: op.kind, state: op.state }))).toEqual([{ kind: "archive", state: "queued" }, { kind: "star", state: "queued" }]);
      expect((await store.ops.get(archived.opIds[0]!))?.state).toBe("queued");
      expect((await store.threads.searchText({ query: "repairneedle", limit: 20, now: 4 })).items.map((thread) => thread.id)).toEqual([threadId]);
      await store.debug.verify();
    });
  });
}
