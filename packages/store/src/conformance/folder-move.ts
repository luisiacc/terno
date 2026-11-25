import { folderRef, type FilterRule } from "@terno/core";
import { afterEach, describe, expect, it } from "vitest";
import type { MailStore } from "../mail-store";
import type { IncomingMessage } from "../types";
import { ingest, msg, outlookAccount, threadOf, withAccounts } from "./fixtures";
import type { StoreHarness } from "./store";

const NOW = Date.UTC(2026, 10, 3, 15, 30);
const loc = (mailbox: string, uid: number) => ({ mailbox, uidvalidity: 1, uid, flags: [] as string[] });

/**
 * Plan 127: mail moved to an account's own folder. It shows there at once (a pending op counts, replayed in order);
 * it leaves the Inbox like an archive unless it's in a category shown there and none hidden; Gmail's labels change
 * when the op succeeds, so a failure leaves nothing behind; a move and its undo are exact.
 */
export function defineFolderMoveConformance(name: string, harness: StoreHarness): void {
  const open: MailStore[] = [];
  afterEach(async () => {
    for (const s of open.splice(0)) if (s.isOpen) await s.close();
  });
  const fresh = async () => {
    const s = await harness.open();
    open.push(s);
    const [gmail, imap] = await withAccounts(s);
    await s.folders.replace(gmail!, [{ key: "Label_A", path: ["A"], selectable: true }, { key: "Label_B", path: ["B"], selectable: true }]);
    await s.folders.replace(imap!, [{ key: "A", path: ["A"], selectable: true }, { key: "B", path: ["B"], selectable: true }]);
    return { store: s, gmail: gmail!, imap: imap! };
  };
  const list = async (store: MailStore, accountId: number, folder: string) => (await store.threads.list({ view: "all", accountId, folder, limit: 50, now: NOW })).items.map((t) => t.id);
  const inbox = async (store: MailStore) => (await store.threads.list({ view: "inbox", limit: 50, now: NOW })).items.map((t) => t.id);
  /** runs every queued op as `settle` says, in the order the queue allows */
  const settleAll = async (store: MailStore, settle: (id: string) => Promise<unknown> = (id) => store.ops.complete(id, {}, NOW)) => {
    const kinds: string[] = [];
    for (;;) {
      const claimed = await store.ops.claimReady(NOW + 1_000_000, 1);
      if (!claimed.length) return kinds;
      kinds.push(claimed[0]!.kind);
      await settle(claimed[0]!.id);
    }
  };
  const gmailThread = async (store: MailStore, gmail: number, id: string, labels = ["INBOX"]) => {
    const { inserted } = await ingest(store, [msg({ accountId: gmail, providerMsgId: id, rfcMessageId: `${id}@t`, gmailLabels: labels, inInbox: labels.includes("INBOX") })]);
    return { thread: await threadOf(store, id), message: inserted[0]! };
  };

  describe(`moving mail to a folder (plan 127): ${name}`, () => {
    it("Gmail: only the moved thread leaves the Inbox and shows in the folder at once; its label comes when the op succeeds", async () => {
      const { store, gmail } = await fresh();
      const a = await gmailThread(store, gmail, "g1");
      const other = await gmailThread(store, gmail, "g2");
      const r = await store.threads.moveToFolder({ threadIds: [a.thread], accountId: gmail, folder: "Label_A", from: null, now: NOW });
      expect(r.kept).toEqual([]);
      expect(r.leftInbox).toEqual([a.thread]);
      expect(r.moved.fromInbox).toEqual([a.message]);
      expect(await inbox(store)).toEqual([other.thread]);
      expect(await list(store, gmail, "Label_A")).toEqual([a.thread]);
      expect((await store.threads.counts(NOW)).folderUnread?.[folderRef(gmail, "Label_A")]).toBeDefined();
      // the move, then the archive
      expect(await settleAll(store)).toEqual(["moveToFolder", "archive"]);
      expect(await list(store, gmail, "Label_A")).toEqual([a.thread]);
    });

    it("a thread in a category shown in the Inbox stays there, and in the folder; a hidden one wins", async () => {
      const { store, gmail } = await fresh();
      const shown = (await store.categories.create("Shown", "cyan", { showInInbox: true })).id;
      const hidden = (await store.categories.create("Hidden", "brown", { showInInbox: false })).id;
      const kept = await gmailThread(store, gmail, "kept");
      const both = await gmailThread(store, gmail, "both");
      const plain = await gmailThread(store, gmail, "plain");
      await store.categories.add({ categoryId: shown, threadIds: [kept.thread, both.thread], addedBy: "user", now: NOW });
      await store.categories.add({ categoryId: hidden, threadIds: [both.thread], addedBy: "user", now: NOW });
      const r = await store.threads.moveToFolder({ threadIds: [kept.thread, both.thread, plain.thread], accountId: gmail, folder: "Label_A", from: null, now: NOW });
      expect(r.kept).toEqual([kept.thread]);
      expect(new Set(r.leftInbox)).toEqual(new Set([both.thread, plain.thread]));
      expect(await inbox(store)).toEqual([kept.thread]);
      expect(new Set(await list(store, gmail, "Label_A"))).toEqual(new Set([kept.thread, both.thread, plain.thread]));
      expect(r.before.map((m) => m.id).sort()).toEqual([both.message, plain.message].sort());
      // its category is still its
      expect((await store.threads.summaries([kept.thread]))[0]!.categoryIds).toEqual([shown]);
      await settleAll(store);
      expect(await inbox(store)).toEqual([kept.thread]);
      expect(new Set(await list(store, gmail, "Label_A"))).toEqual(new Set([kept.thread, both.thread, plain.thread]));
    });

    it("a thread already out of the Inbox isn't brought back by a shown category", async () => {
      const { store, gmail } = await fresh();
      const shown = (await store.categories.create("Shown", "cyan", { showInInbox: true })).id;
      const t = await gmailThread(store, gmail, "archived", []);
      await store.categories.add({ categoryId: shown, threadIds: [t.thread], addedBy: "user", now: NOW });
      const r = await store.threads.moveToFolder({ threadIds: [t.thread], accountId: gmail, folder: "Label_A", from: null, now: NOW });
      expect(r.kept).toEqual([]);
      expect(await inbox(store)).toEqual([]);
      expect(r.moved.added).toEqual([t.message]);
    });

    it("another account's thread, and one in Trash, are left alone", async () => {
      const { store, gmail, imap } = await fresh();
      const elsewhere = await gmailThread(store, gmail, "g");
      const { inserted: [m] } = await ingest(store, [msg({ accountId: imap, providerMsgId: "i", locations: [loc("INBOX", 1)], inInbox: true })]);
      const thread = await threadOf(store, "i");
      const trashed = await gmailThread(store, gmail, "t");
      await store.threads.act({ threadIds: [trashed.thread], action: "trash", signal: null, now: NOW });
      const r = await store.threads.moveToFolder({ threadIds: [elsewhere.thread, thread], accountId: imap, folder: "A", from: null, now: NOW });
      expect(r.threadIds).toEqual([thread]);
      expect(r.moved.fromInbox).toEqual([m]);
      const t = await store.threads.moveToFolder({ threadIds: [trashed.thread], accountId: gmail, folder: "Label_A", from: null, now: NOW });
      expect(t).toMatchObject({ threadIds: [], opIds: [] });
      expect(await list(store, gmail, "Label_A")).toEqual([]);
    });

    it("from one folder to another: the source goes and the destination comes at once; A → B → A shows the last", async () => {
      const { store, imap } = await fresh();
      await ingest(store, [msg({ accountId: imap, providerMsgId: "i", locations: [loc("A", 1)], inInbox: false })]);
      const thread = await threadOf(store, "i");
      expect(await list(store, imap, "A")).toEqual([thread]);
      await store.threads.moveToFolder({ threadIds: [thread], accountId: imap, folder: "B", from: "A", now: NOW });
      expect(await list(store, imap, "A")).toEqual([]);
      expect(await list(store, imap, "B")).toEqual([thread]);
      // a recompute while it's on its way (a read mark) keeps it
      await store.threads.act({ threadIds: [thread], action: "markRead", signal: null, now: NOW });
      expect(await list(store, imap, "A")).toEqual([]);
      expect(await list(store, imap, "B")).toEqual([thread]);
      await store.threads.moveToFolder({ threadIds: [thread], accountId: imap, folder: "A", from: "B", now: NOW });
      expect(await list(store, imap, "A")).toEqual([thread]);
      expect(await list(store, imap, "B")).toEqual([]);
    });

    it("Outlook (plan 259): a move on its way replaces the message's one folder, never leaves it in both; a read from before doesn't undo it; failing shows what's true", async () => {
      const { store } = await fresh();
      const outlook = await outlookAccount(store);
      await store.folders.replace(outlook, ["F1", "F2", "F3"].map((key) => ({ key, path: [key], selectable: true })));
      await ingest(store, [msg({ accountId: outlook, providerMsgId: "o", inInbox: false, folder: "F1" })]);
      const thread = await threadOf(store, "o");
      const where = async () => Object.fromEntries(await Promise.all(["F1", "F2", "F3"].map(async (f) => [f, (await list(store, outlook, f)).length] as const)));
      // `from` unsaid: Graph still has it in one place only
      const first = await store.threads.moveToFolder({ threadIds: [thread], accountId: outlook, folder: "F2", from: null, now: NOW });
      expect(await where()).toEqual({ F1: 0, F2: 1, F3: 0 });
      // a delta read from before the move, and a recompute, keep it where it's going
      await ingest(store, [msg({ accountId: outlook, providerMsgId: "o", inInbox: false, folder: "F1" })]);
      await store.threads.act({ threadIds: [thread], action: "markRead", signal: null, now: NOW });
      expect(await where()).toEqual({ F1: 0, F2: 1, F3: 0 });
      // replayed in order: the last one decides
      const second = await store.threads.moveToFolder({ threadIds: [thread], accountId: outlook, folder: "F3", from: "F2", now: NOW });
      expect(await where()).toEqual({ F1: 0, F2: 0, F3: 1 });
      // each fails: what's left on its way, then what the server said
      expect([...first.opIds, ...second.opIds]).toHaveLength(2);
      // (the read mark's op settles on its way)
      const fail = async (id: string) => {
        for (;;) {
          const [op] = await store.ops.claimReady(NOW + 1, 1);
          if (op!.kind !== "moveToFolder") { await store.ops.complete(op!.id, {}, NOW); continue; }
          expect(op!.id).toBe(id);
          return store.ops.fail(op!.id, "refused", false, NOW);
        }
      };
      await fail(first.opIds[0]!);
      expect(await where()).toEqual({ F1: 0, F2: 0, F3: 1 });
      await fail(second.opIds[0]!);
      expect(await where()).toEqual({ F1: 1, F2: 0, F3: 0 });
    });

    it("Outlook (stage 2b): one move a message, never a copy: it leaves the Inbox whatever its category says; each one's way back is journalled; your own mail stays in Sent", async () => {
      const { store } = await fresh();
      const outlook = await outlookAccount(store);
      await store.folders.replace(outlook, ["F1", "F2"].map((key) => ({ key, path: [key], selectable: true })));
      const shown = (await store.categories.create("Shown", "cyan", { showInInbox: true })).id;
      const { inserted } = await ingest(store, [
        msg({ accountId: outlook, providerMsgId: "in", rfcMessageId: "in@t", inInbox: true, folder: null }),
        msg({ accountId: outlook, providerMsgId: "reply", rfcMessageId: "reply@t", inReplyTo: "in@t", references: ["in@t"], isSent: true, inInbox: false, folder: null }),
        msg({ accountId: outlook, providerMsgId: "archived", rfcMessageId: "archived@t", inInbox: false, folder: null }),
        msg({ accountId: outlook, providerMsgId: "other", rfcMessageId: "other@t", inInbox: false, folder: "F2" }),
        msg({ accountId: outlook, providerMsgId: "solo", rfcMessageId: "solo@t", isSent: true, inInbox: false, folder: null }),
      ]);
      const [inId, , archivedId, otherId, soloId] = inserted;
      const threads = await Promise.all(["in", "archived", "other", "solo"].map((id) => threadOf(store, id)));
      await store.categories.add({ categoryId: shown, threadIds: [threads[0]!], addedBy: "user", now: NOW });
      const r = await store.threads.moveToFolder({ threadIds: threads, accountId: outlook, folder: "F1", from: null, now: NOW });
      // the owner's decision: Graph keeps a message in one place, so a shown category keeps nothing in the Inbox
      expect(r.kept).toEqual([]);
      expect(r.leftInbox).toEqual([threads[0]]);
      expect(await inbox(store)).toEqual([]);
      expect(r.moved.fromInbox).toEqual([inId]);
      expect(r.moved.fromFolder).toEqual([]);
      expect(r.moved.added).toEqual([]);
      expect(r.moved.elsewhere).toEqual(expect.arrayContaining([
        { back: null, role: "archive", messageIds: [archivedId] },
        { back: "F2", messageIds: [otherId] },
        { back: null, role: "sent", messageIds: [soloId] },
      ]));
      expect(r.moved.elsewhere).toHaveLength(3);
      expect(new Set(await list(store, outlook, "F1"))).toEqual(new Set(threads));
      expect(await list(store, outlook, "F2")).toEqual([]);
      // one move op with every message but the reply, which stays in Sent; no copy kept in the Inbox, and no archive
      // after it (Codex code review #3): the op list is that move and nothing else
      const ops = await store.ops.recent(10);
      expect(ops.map((o) => o.kind)).toEqual(["moveToFolder"]);
      expect(r.opIds).toEqual([ops[0]!.id]);
      expect(JSON.parse(ops[0]!.payload_json)).toEqual({ folder: "F1", from: null, keepInbox: false, fromInbox: [inId] });
      expect((JSON.parse(ops[0]!.target_json) as { messageIds: number[] }).messageIds.sort()).toEqual([inId, archivedId, otherId, soloId].sort());
      // the undo: each back where it was, the Inbox's with its own flag back
      await settleAll(store);
      const left = await store.threads.leaveFolder({ moved: r.moved, now: NOW });
      expect(left.opIds).toHaveLength(4);
      const payloads = (await store.ops.recent(20)).filter((o) => o.kind === "leaveFolder").map((o) => JSON.parse(o.payload_json) as Record<string, unknown>);
      expect(payloads).toEqual(expect.arrayContaining([
        { folder: "F1", back: null, toInbox: true, stays: false },
        { folder: "F1", back: null, toInbox: false, stays: false, role: "archive" },
        { folder: "F1", back: "F2", toInbox: false, stays: false },
        { folder: "F1", back: null, toInbox: false, stays: false, role: "sent" },
      ]));
      // shown at once where each goes back to
      expect(await list(store, outlook, "F1")).toEqual([]);
      expect(await list(store, outlook, "F2")).toEqual([threads[2]]);
    });

    it("Outlook (review round 3): a folder's stored messages page by id; a stored draft says it's one", async () => {
      const { store } = await fresh();
      const outlook = await outlookAccount(store);
      await store.folders.replace(outlook, ["F1", "F2"].map((key) => ({ key, path: [key], selectable: true })));
      const { inserted } = await ingest(store, [
        ...Array.from({ length: 52 }, (_, i) => msg({ accountId: outlook, providerMsgId: `f1-${i}`, rfcMessageId: `f1-${i}@t`, inInbox: false, folder: "F1" })),
        msg({ accountId: outlook, providerMsgId: "f2", rfcMessageId: "f2@t", inInbox: false, folder: "F2" }),
        msg({ accountId: outlook, providerMsgId: "draft", rfcMessageId: "draft@t", inInbox: false, isDraft: true, folder: null }),
      ]);
      const provider = store.providerStore(outlook);
      const first = await provider.folderMessagePage("F1");
      expect(first.items).toHaveLength(50);
      expect(first.items.map((m) => m.providerMsgId)).toEqual(Array.from({ length: 50 }, (_, i) => `f1-${i}`));
      const second = await provider.folderMessagePage("F1", first.next);
      expect(second).toEqual({ items: [{ id: inserted[50], providerMsgId: "f1-50" }, { id: inserted[51], providerMsgId: "f1-51" }] });
      expect(await provider.folderMessagePage("F2")).toEqual({ items: [{ id: inserted[52], providerMsgId: "f2" }] });
      expect(await provider.folderMessagePage("gone")).toEqual({ items: [] });
      expect(await provider.messageByProviderId("draft")).toMatchObject({ isDraft: true });
      expect(await provider.messageByProviderId("f2")).toMatchObject({ isDraft: false });
    });

    it("Outlook (review round 3): your own message in the Inbox (a note to yourself) goes with its conversation, so it leaves the Inbox", async () => {
      const { store } = await fresh();
      const outlook = await outlookAccount(store);
      await store.folders.replace(outlook, [{ key: "F1", path: ["F1"], selectable: true }]);
      const { inserted: [inId, selfId] } = await ingest(store, [
        msg({ accountId: outlook, providerMsgId: "in", rfcMessageId: "in@t", inInbox: true, folder: null }),
        msg({ accountId: outlook, providerMsgId: "self", rfcMessageId: "self@t", inReplyTo: "in@t", references: ["in@t"], isSent: true, inInbox: true, folder: null }),
      ]);
      const thread = await threadOf(store, "in");
      const r = await store.threads.moveToFolder({ threadIds: [thread], accountId: outlook, folder: "F1", from: null, now: NOW });
      expect(r.moved.fromInbox.sort()).toEqual([inId, selfId].sort());
      expect(await inbox(store)).toEqual([]);
      expect(await list(store, outlook, "F1")).toEqual([thread]);
    });

    it("Outlook (stage 2b): the provider's answers are written as they come; a partial success keeps what was done, and an unknown outcome shows only what's confirmed", async () => {
      const { store } = await fresh();
      const outlook = await outlookAccount(store);
      await store.folders.replace(outlook, ["F1", "F2"].map((key) => ({ key, path: [key], selectable: true })));
      const { inserted } = await ingest(store, [
        msg({ accountId: outlook, providerMsgId: "a", rfcMessageId: "a@t", inInbox: false, folder: "F2" }),
        msg({ accountId: outlook, providerMsgId: "b", rfcMessageId: "b@t", inInbox: false, folder: "F2" }),
      ]);
      const [a, b] = inserted as [number, number];
      const ta = await threadOf(store, "a"), tb = await threadOf(store, "b");
      const r = await store.threads.moveToFolder({ threadIds: [ta, tb], accountId: outlook, folder: "F1", from: "F2", now: NOW });
      expect(r.moved.fromFolder.sort()).toEqual([a, b].sort());
      const [op] = await store.ops.claimReady(NOW + 1, 1);
      expect(op!.kind).toBe("moveToFolder");
      // the first answer came back: written at once (a row whose provider id changed meanwhile isn't)
      const provider = store.providerStore(outlook);
      expect(await provider.placeMessages([{ messageId: a, providerMsgId: "a", folder: "F1" }, { messageId: b, providerMsgId: "not-b", folder: "F1" }])).toEqual([ta]);
      // the second never did: the op ends unknown, and the folder shows what's confirmed only
      await store.ops.markUnknown(op!.id, "lost", NOW);
      expect(await list(store, outlook, "F1")).toEqual([ta]);
      expect(await list(store, outlook, "F2")).toEqual([tb]);
      // the same for a permanent failure part-way
      const again = await store.threads.moveToFolder({ threadIds: [tb], accountId: outlook, folder: "F1", from: "F2", now: NOW });
      expect(await list(store, outlook, "F1")).toEqual(expect.arrayContaining([ta, tb]));
      const [next] = await store.ops.claimReady(NOW + 1, 1);
      expect(next!.id).toBe(again.opIds[0]);
      await store.ops.fail(next!.id, "refused", false, NOW);
      expect(await list(store, outlook, "F2")).toEqual([tb]);
      // a role folder's answer takes the message out of its user folder (its flags say where)
      expect(await provider.placeMessages([{ messageId: b, providerMsgId: "b", folder: null }])).toEqual([tb]);
      expect(await list(store, outlook, "F2")).toEqual([]);
      // the same answer again changes nothing
      expect(await provider.placeMessages([{ messageId: b, providerMsgId: "b", folder: null }])).toEqual([]);
    });

    it("Outlook (Codex code review #3): a filing that never lands archives nothing: what it took out of the Inbox comes back, what the server confirmed stays filed", async () => {
      const { store } = await fresh();
      const outlook = await outlookAccount(store);
      await store.folders.replace(outlook, [{ key: "F1", path: ["F1"], selectable: true }]);
      const { inserted } = await ingest(store, [
        msg({ accountId: outlook, providerMsgId: "a", rfcMessageId: "a@t", inInbox: true, folder: null }),
        msg({ accountId: outlook, providerMsgId: "b", rfcMessageId: "b@t", inInbox: true, folder: null }),
      ]);
      const [a, b] = inserted as [number, number];
      const ta = await threadOf(store, "a"), tb = await threadOf(store, "b");
      const r = await store.threads.moveToFolder({ threadIds: [ta, tb], accountId: outlook, folder: "F1", from: null, now: NOW });
      expect(r.leftInbox.sort()).toEqual([ta, tb].sort());
      expect(await inbox(store)).toEqual([]);
      const [op] = await store.ops.claimReady(NOW + 1, 1);
      // the first message's move landed; the second's was refused for good
      await store.providerStore(outlook).placeMessages([{ messageId: a, providerMsgId: "a", folder: "F1" }]);
      await store.ops.fail(op!.id, "refused", false, NOW);
      expect(await inbox(store)).toEqual([tb]);
      expect(await list(store, outlook, "F1")).toEqual([ta]);
      // nothing else is queued: no archive takes it there behind the failure
      expect(await store.ops.claimReady(NOW + 1, 10)).toEqual([]);
      void b;
    });

    it("Outlook (round 2 #6, #7): a landed filing ends a stale Inbox read; a failed one never brings back what something newer moves", async () => {
      const { store } = await fresh();
      const outlook = await outlookAccount(store);
      await store.folders.replace(outlook, ["F1", "F2"].map((key) => ({ key, path: [key], selectable: true })));
      const { inserted } = await ingest(store, [msg({ accountId: outlook, providerMsgId: "a", rfcMessageId: "a@t", inInbox: true, folder: null })]);
      const a = inserted[0]!;
      const thread = await threadOf(store, "a");
      await store.threads.moveToFolder({ threadIds: [thread], accountId: outlook, folder: "F1", from: null, now: NOW });
      // a delta page read before the move landed puts it back in the Inbox while the move is on its way
      await store.sync.updateFlags(outlook, [{ messageId: a, expectedProviderMsgId: "a", flags: { inInbox: true }, folder: null }]);
      const [op] = await store.ops.claimReady(NOW + 1, 1);
      await store.providerStore(outlook).placeMessages([{ messageId: a, providerMsgId: "a", folder: "F1" }]);
      await store.ops.complete(op!.id, {}, NOW);
      // landed: in the folder, and out of the Inbox
      expect(await inbox(store)).toEqual([]);
      expect(await list(store, outlook, "F1")).toEqual([thread]);
      // filed back to the Inbox's sibling, then on to F2 before the first settles: the first failing brings nothing back
      const { inserted: more } = await ingest(store, [msg({ accountId: outlook, providerMsgId: "b", rfcMessageId: "b@t", inInbox: true, folder: null })]);
      const tb = await threadOf(store, "b");
      await store.threads.moveToFolder({ threadIds: [tb], accountId: outlook, folder: "F1", from: null, now: NOW });
      await store.threads.moveToFolder({ threadIds: [tb], accountId: outlook, folder: "F2", from: "F1", now: NOW });
      const [first] = await store.ops.claimReady(NOW + 1, 1);
      await store.ops.fail(first!.id, "refused", false, NOW);
      expect(await inbox(store)).toEqual([]);
      void more;
    });

    it("Outlook (stage 2b): a delta read racing a settlement shows the move while it's on its way, and the next read decides", async () => {
      const { store } = await fresh();
      const outlook = await outlookAccount(store);
      await store.folders.replace(outlook, ["F1", "F2"].map((key) => ({ key, path: [key], selectable: true })));
      const { inserted } = await ingest(store, [msg({ accountId: outlook, providerMsgId: "o", rfcMessageId: "o@t", inInbox: false, folder: "F2" })]);
      const id = inserted[0]!;
      const thread = await threadOf(store, "o");
      await store.threads.moveToFolder({ threadIds: [thread], accountId: outlook, folder: "F1", from: "F2", now: NOW });
      const [op] = await store.ops.claimReady(NOW + 1, 1);
      // the provider's answer, then a delta page read before the move lands writing the old folder
      await store.providerStore(outlook).placeMessages([{ messageId: id, providerMsgId: "o", folder: "F1" }]);
      await store.sync.updateFlags(outlook, [{ messageId: id, expectedProviderMsgId: "o", flags: { isRead: true }, folder: "F2" }]);
      // while the op is on its way it shows where it's going
      expect(await list(store, outlook, "F1")).toEqual([thread]);
      expect(await list(store, outlook, "F2")).toEqual([]);
      await store.ops.complete(op!.id, {}, NOW);
      // settled: the stale read shows until the next delta (its @removed and the destination's entry) says where it is
      await store.sync.updateFlags(outlook, [{ messageId: id, expectedProviderMsgId: "o", flags: {}, folder: "F1" }]);
      expect(await list(store, outlook, "F1")).toEqual([thread]);
      expect(await list(store, outlook, "F2")).toEqual([]);
    });

    it("Outlook (stage 2b): a filing replays what's on its way first: A → B then B → C moves from B, and its undo goes back to B", async () => {
      const { store } = await fresh();
      const outlook = await outlookAccount(store);
      await store.folders.replace(outlook, ["A", "B", "C"].map((key) => ({ key, path: [key], selectable: true })));
      const { inserted } = await ingest(store, [msg({ accountId: outlook, providerMsgId: "o", rfcMessageId: "o@t", inInbox: false, folder: "A" })]);
      const thread = await threadOf(store, "o");
      await store.threads.moveToFolder({ threadIds: [thread], accountId: outlook, folder: "B", from: "A", now: NOW });
      const second = await store.threads.moveToFolder({ threadIds: [thread], accountId: outlook, folder: "C", from: null, now: NOW });
      expect(second.moved.elsewhere).toEqual([{ back: "B", messageIds: [inserted[0]] }]);
      // filing it to where it's already going does nothing
      const same = await store.threads.moveToFolder({ threadIds: [thread], accountId: outlook, folder: "C", from: null, now: NOW });
      expect(same.opIds).toEqual([]);
    });

    it("a failed move shows what's true: gone from the folder, no label left behind", async () => {
      const { store, gmail } = await fresh();
      const a = await gmailThread(store, gmail, "g1");
      const r = await store.threads.moveToFolder({ threadIds: [a.thread], accountId: gmail, folder: "Label_A", from: null, now: NOW });
      expect(await list(store, gmail, "Label_A")).toEqual([a.thread]);
      const [op] = await store.ops.claimReady(NOW + 1, 1);
      expect(op!.id).toBe(r.opIds[0]);
      await store.ops.fail(op!.id, "refused", false, NOW);
      expect(await list(store, gmail, "Label_A")).toEqual([]);
      // a later recompute agrees: nothing was written to the labels
      await store.threads.act({ threadIds: [a.thread], action: "markRead", signal: null, now: NOW });
      expect(await list(store, gmail, "Label_A")).toEqual([]);
    });

    it("a sync read from before the move doesn't take it out of the folder while the op is on its way", async () => {
      const { store, gmail } = await fresh();
      const a = await gmailThread(store, gmail, "g1");
      await store.threads.moveToFolder({ threadIds: [a.thread], accountId: gmail, folder: "Label_A", from: null, now: NOW });
      await store.sync.updateFlags(gmail, [{ messageId: a.message, flags: {}, gmailLabels: ["INBOX"] }]);
      expect(await list(store, gmail, "Label_A")).toEqual([a.thread]);
    });

    it("undo: leaveFolder then restore puts everything back, at once and after the ops", async () => {
      const { store, gmail } = await fresh();
      const a = await gmailThread(store, gmail, "g1");
      const r = await store.threads.moveToFolder({ threadIds: [a.thread], accountId: gmail, folder: "Label_A", from: null, now: NOW });
      await settleAll(store);
      await store.threads.leaveFolder({ moved: r.moved, now: NOW });
      await store.threads.restore({ messages: r.before, now: NOW });
      expect(await list(store, gmail, "Label_A")).toEqual([]);
      expect(await inbox(store)).toEqual([a.thread]);
      expect(await settleAll(store)).toEqual(["leaveFolder", "moveToInbox"]);
      expect(await list(store, gmail, "Label_A")).toEqual([]);
      expect(await inbox(store)).toEqual([a.thread]);
    });

    it("undo of a label the message already had keeps it; the source comes back", async () => {
      const { store, gmail } = await fresh();
      const a = await gmailThread(store, gmail, "g1", ["Label_A", "Label_B"]);
      const r = await store.threads.moveToFolder({ threadIds: [a.thread], accountId: gmail, folder: "Label_A", from: "Label_B", now: NOW });
      expect(r.moved.leftOnly).toEqual([a.message]);
      expect(await list(store, gmail, "Label_B")).toEqual([]);
      await settleAll(store);
      expect(await list(store, gmail, "Label_B")).toEqual([]);
      await store.threads.leaveFolder({ moved: r.moved, now: NOW });
      await settleAll(store);
      expect(await list(store, gmail, "Label_A")).toEqual([a.thread]);
      expect(await list(store, gmail, "Label_B")).toEqual([a.thread]);
    });

    it("IMAP: your own mail stays in Sent unless it's all there is", async () => {
      const { store, imap } = await fresh();
      const { inserted } = await ingest(store, [
        msg({ accountId: imap, providerMsgId: "in", rfcMessageId: "in@t", providerThreadId: "t", locations: [loc("INBOX", 1)], inInbox: true }),
        msg({ accountId: imap, providerMsgId: "out", rfcMessageId: "out@t", providerThreadId: "t", isSent: true, inReplyTo: "in@t", references: ["in@t"], locations: [loc("Sent", 1)], inInbox: false }),
        msg({ accountId: imap, providerMsgId: "solo", rfcMessageId: "solo@t", isSent: true, locations: [loc("Sent", 2)], inInbox: false }),
      ]);
      const r = await store.threads.moveToFolder({ threadIds: [await threadOf(store, "in"), await threadOf(store, "solo")], accountId: imap, folder: "A", from: null, now: NOW });
      expect(r.moved.fromInbox).toEqual([inserted[0]]);
      expect(r.moved.added).toEqual([inserted[2]]);
    });

    it("IMAP: leaving a folder takes all the thread's copies there, your own too, so the row that leaves the list really has", async () => {
      const { store, imap } = await fresh();
      await ingest(store, [
        msg({ accountId: imap, providerMsgId: "out", rfcMessageId: "out@t", providerThreadId: "t", isSent: true, locations: [loc("A", 1)], inInbox: false }),
        msg({ accountId: imap, providerMsgId: "in", rfcMessageId: "in@t", providerThreadId: "t", inReplyTo: "out@t", references: ["out@t"], locations: [loc("A", 2)], inInbox: false }),
      ]);
      const thread = await threadOf(store, "in");
      expect(await list(store, imap, "A")).toEqual([thread]);
      const r = await store.threads.moveToFolder({ threadIds: [thread], accountId: imap, folder: "B", from: "A", now: NOW });
      expect(r.moved.fromFolder).toHaveLength(2);
      expect(await list(store, imap, "A")).toEqual([]);
      expect(await list(store, imap, "B")).toEqual([thread]);
    });

    it("an unknown outcome stops counting at once: the folder shows only what's known", async () => {
      const { store, imap } = await fresh();
      await ingest(store, [msg({ accountId: imap, providerMsgId: "i", locations: [loc("INBOX", 1)], inInbox: true })]);
      const thread = await threadOf(store, "i");
      await store.threads.moveToFolder({ threadIds: [thread], accountId: imap, folder: "A", from: null, now: NOW });
      expect(await list(store, imap, "A")).toEqual([thread]);
      const [op] = await store.ops.claimReady(NOW + 1, 1);
      await store.ops.markUnknown(op!.id, "lost", NOW);
      expect(await list(store, imap, "A")).toEqual([]);
    });

    it("offers count what would still change: this account's threads not in the folder, starred and replied ones too", async () => {
      const { store, gmail, imap } = await fresh();
      const mk = (accountId: number, id: string) => msg({ accountId, providerMsgId: id, rfcMessageId: `${id}@t`, from: { email: "shop@example.com", name: "Shop" }, gmailLabels: accountId === gmail ? ["INBOX"] : undefined, inInbox: true });
      await ingest(store, [mk(gmail, "a"), mk(gmail, "b"), mk(gmail, "c"), mk(imap, "d")]);
      const [a, b] = [await threadOf(store, "a"), await threadOf(store, "b")];
      await store.threads.act({ threadIds: [b], action: "star", signal: null, now: NOW });
      const target = { accountId: gmail, folder: "Label_A" };
      await store.threads.moveToFolder({ threadIds: [a], accountId: gmail, folder: "Label_A", from: null, now: NOW });
      const offers = await store.similar.offers([a], target);
      const sender = offers.offers.find((o) => o.scope.kind === "sender")!;
      // b (starred) and c; not a (there now), not d (another account's)
      expect(sender.count).toBe(2);
      expect(sender.skipped).toBe(0);
      const page = await store.similar.resolvePage(sender.scope, target, [], null, 2000);
      expect(new Set(page.ids)).toEqual(new Set([b, await threadOf(store, "c")]));
      expect(page.kept).toEqual([]);
    });
  });

  describe(`filters that move new mail to a folder (plan 128): ${name}`, () => {
    const FROM = { name: "Uber", email: "uber@example.com" };
    const fromUber: FilterRule["conditions"] = [{ field: "from", op: "equals", value: FROM.email }];
    const filter = (store: MailStore, actions: FilterRule["actions"], conditions = fromUber) => store.filters.save({ name: `f${JSON.stringify(actions)}`, enabled: true, source: "manual", rule: { match: "all", conditions, actions } }, NOW);
    const toFolder = (accountId: number, folder: string) => ({ type: "moveToFolder" as const, accountId, folder });
    const arrive = async (store: MailStore, over: Partial<IncomingMessage> & { accountId: number; providerMsgId: string }) => {
      const r = await ingest(store, [msg({ from: FROM, ...over })], NOW);
      return { ...r, thread: await threadOf(store, over.providerMsgId) };
    };
    const newGmail = (accountId: number, id: string, labels = ["INBOX"]) => ({ accountId, providerMsgId: id, rfcMessageId: `${id}@t`, gmailLabels: labels, inInbox: labels.includes("INBOX") });
    const newImap = (accountId: number, id: string, uid = 1, mailbox = "INBOX") => ({ accountId, providerMsgId: id, rfcMessageId: `${id}@t`, locations: [loc(mailbox, uid)], inInbox: mailbox === "INBOX" });
    const queued = async (store: MailStore) => (await store.debug.snapshot()).ops.filter((o) => o.state === "queued").map((o) => o.kind);

    it("Gmail: new mail goes to the folder and not the Inbox, with its ops; other mail isn't touched", async () => {
      const { store, gmail } = await fresh();
      await filter(store, [toFolder(gmail, "Label_A")]);
      const moved = await arrive(store, newGmail(gmail, "n1"));
      const other = await ingest(store, [msg({ ...newGmail(gmail, "n2"), from: { name: "Ana", email: "ana@example.com" } })], NOW);
      expect(moved.opIds.length).toBe(2);
      expect(await list(store, gmail, "Label_A")).toEqual([moved.thread]);
      expect(await inbox(store)).toEqual([await threadOf(store, "n2")]);
      expect(other.opIds).toEqual([]);
      expect(await settleAll(store)).toEqual(["moveToFolder", "archive"]);
      expect(await list(store, gmail, "Label_A")).toEqual([moved.thread]);
    });

    it("IMAP: the same, shown in the folder before the server has answered", async () => {
      const { store, imap } = await fresh();
      await filter(store, [toFolder(imap, "A")]);
      const { thread } = await arrive(store, newImap(imap, "n"));
      expect(await list(store, imap, "A")).toEqual([thread]);
      expect(await inbox(store)).toEqual([]);
      expect(await queued(store)).toEqual(["moveToFolder", "archive"]);
    });

    it("a category shown in the Inbox keeps it there, whichever filter comes first; a hidden one wins", async () => {
      const { store, gmail } = await fresh();
      const shown = (await store.categories.create("Shown", "cyan", { showInInbox: true })).id;
      const hidden = (await store.categories.create("Hidden", "brown", { showInInbox: false })).id;
      // the folder's filter first: its move still waits for the category's
      await filter(store, [toFolder(gmail, "Label_A")]);
      await filter(store, [{ type: "addCategory", categoryId: shown }]);
      const kept = await arrive(store, newGmail(gmail, "kept"));
      expect(await list(store, gmail, "Label_A")).toEqual([kept.thread]);
      expect(await inbox(store)).toEqual([kept.thread]);
      expect(await queued(store)).toEqual(["moveToFolder"]);
      await filter(store, [{ type: "addCategory", categoryId: hidden }]);
      const both = await arrive(store, newGmail(gmail, "both"));
      expect(new Set(await list(store, gmail, "Label_A"))).toEqual(new Set([kept.thread, both.thread]));
      expect(await inbox(store)).toEqual([kept.thread]);
    });

    it("only its own account's mail moves; the rule's other actions still run on the rest", async () => {
      const { store, gmail, imap } = await fresh();
      await filter(store, [toFolder(gmail, "Label_A"), { type: "markRead" }]);
      const { thread, opIds } = await arrive(store, newImap(imap, "elsewhere"));
      expect(await inbox(store)).toEqual([thread]);
      expect(await list(store, gmail, "Label_A")).toEqual([]);
      expect(await list(store, imap, "A")).toEqual([]);
      expect(opIds.length).toBe(1);
      expect(await queued(store)).toEqual(["markRead"]);
    });

    it("mail already put somewhere isn't moved on arrival: another folder, Archive, your own, Trash", async () => {
      const { store, imap } = await fresh();
      await filter(store, [toFolder(imap, "A")]);
      await arrive(store, newImap(imap, "in-b", 1, "B"));
      await arrive(store, newImap(imap, "archived", 1, "Archive"));
      await arrive(store, { ...newImap(imap, "mine", 1, "Sent"), isSent: true });
      await arrive(store, { ...newImap(imap, "mine-in-inbox", 2), isSent: true });
      await arrive(store, { ...newImap(imap, "trashed", 1, "Trash"), isTrash: true });
      expect(await list(store, imap, "A")).toEqual([]);
      expect(await queued(store)).toEqual([]);
    });

    it("who reached the Inbox is read before any filter acts: an archive filter or another folder's doesn't stop this one", async () => {
      const { store, gmail } = await fresh();
      await filter(store, [{ type: "archive" }]);
      await filter(store, [toFolder(gmail, "Label_A")]);
      await filter(store, [toFolder(gmail, "Label_B")]);
      const { thread } = await arrive(store, newGmail(gmail, "n"));
      expect(await list(store, gmail, "Label_A")).toEqual([thread]);
      expect(await list(store, gmail, "Label_B")).toEqual([thread]);
      expect(await inbox(store)).toEqual([]);
    });

    it("a trash filter wins, wherever it is in the order", async () => {
      const { store, gmail } = await fresh();
      await filter(store, [toFolder(gmail, "Label_A")]);
      await filter(store, [{ type: "trash" }]);
      await arrive(store, newGmail(gmail, "n"));
      expect(await list(store, gmail, "Label_A")).toEqual([]);
      expect(await queued(store)).toEqual(["trash"]);
    });

    it("a folder that isn't there does nothing: the mail stays in the Inbox, and ingest goes on", async () => {
      const { store, gmail } = await fresh();
      await filter(store, [toFolder(gmail, "Label_Gone")]);
      const { thread, opIds } = await arrive(store, newGmail(gmail, "n"));
      expect(opIds).toEqual([]);
      expect(await inbox(store)).toEqual([thread]);
      expect(await queued(store)).toEqual([]);
    });

    it("an account with no folder list yet is trusted (a first sync): the key is the server's", async () => {
      const s = await harness.open();
      open.push(s);
      const [gmail] = await withAccounts(s);
      await filter(s, [toFolder(gmail!, "Label_A")]);
      await arrive(s, newGmail(gmail!, "n"));
      expect(await inbox(s)).toEqual([]);
      expect(await queued(s)).toEqual(["moveToFolder", "archive"]);
    });

    it("a later action failing takes its move back with the rest of the filter", async () => {
      const { store, gmail } = await fresh();
      await filter(store, [toFolder(gmail, "Label_A"), { type: "addCategory", categoryId: 987654 }]);
      const { thread } = await arrive(store, newGmail(gmail, "n"));
      expect(await inbox(store)).toEqual([thread]);
      expect(await list(store, gmail, "Label_A")).toEqual([]);
      expect(await queued(store)).toEqual([]);
    });

    it("a body filter moves it when the body arrives, in that transaction", async () => {
      const { store, gmail } = await fresh();
      await filter(store, [toFolder(gmail, "Label_A")], [{ field: "body", op: "contains", value: "recibo" }]);
      const { inserted: [m], thread } = await arrive(store, { ...newGmail(gmail, "n"), bodyText: null, bodyState: "none" });
      expect(await inbox(store)).toEqual([thread]);
      const r = await store.sync.setBody(m!, "tu recibo de hoy", null, { now: NOW, classifier: null });
      expect(r.opIds.length).toBe(2);
      expect(await list(store, gmail, "Label_A")).toEqual([thread]);
      expect(await inbox(store)).toEqual([]);
    });

    it("Apply to existing mail takes it from wherever it is, except your own", async () => {
      const { store, imap } = await fresh();
      const { inserted: [archived] } = await ingest(store, [msg({ from: FROM, ...newImap(imap, "archived", 1, "Archive") })], NOW);
      const { inserted: [mine] } = await ingest(store, [msg({ from: FROM, ...newImap(imap, "mine", 1, "Sent"), isSent: true })], NOW);
      const f = await filter(store, [toFolder(imap, "A")]);
      const r = await store.filters.applyChunk(f.id, JSON.stringify(f.rule), [archived!, mine!], NOW);
      expect(r.applied).toBe(2);
      expect(await list(store, imap, "A")).toEqual([await threadOf(store, "archived")]);
      expect(r.opIds.length).toBe(1);
    });
  });

  /**
   * Plan 259 (exact undo): an Outlook message moved by an ordinary location action and undone goes back exactly where
   * it was: its own folder (one filing back), Archive, Sent or Drafts (`returnTo`), or the Inbox, Junk or Deleted Items
   * (their own ops). The provider is played here: each op lands with the folder Graph would answer.
   */
  describe(`exact undo of a location action (plan 259): ${name}`, () => {
    const outlookStore = async () => {
      const { store, imap } = await fresh();
      const outlook = await outlookAccount(store);
      await store.folders.replace(outlook, ["F1", "F2"].map((key) => ({ key, path: [key], selectable: true })));
      return { store, outlook, imap };
    };
    /** one message, in a thread of its own; its id and thread */
    const one = async (store: MailStore, fields: Partial<IncomingMessage> & { accountId: number; providerMsgId: string }) => {
      const { inserted } = await ingest(store, [msg({ rfcMessageId: `${fields.providerMsgId}@t`, ...fields })]);
      return { id: inserted[0]!, thread: await threadOf(store, fields.providerMsgId) };
    };
    const queued = async (store: MailStore) => (await store.ops.recent(50)).filter((o) => o.state === "queued").reverse().map((o) => ({ kind: o.kind, payload: JSON.parse(o.payload_json) as unknown, messageIds: (JSON.parse(o.target_json) as { messageIds: number[] }).messageIds }));
    /** every queued op lands, each message where Graph would put it (`fail`: these never do, and the op fails) */
    const land = async (store: MailStore, outlook: number, providerIds: ReadonlyMap<number, string>, fail: readonly number[] = []) => {
      const kinds: string[] = [];
      for (;;) {
        const [op] = await store.ops.claimReady(NOW + 1_000_000, 1);
        if (!op) return kinds;
        kinds.push(op.kind);
        const payload = JSON.parse(op.payload_json) as { folder?: string };
        const ids = (JSON.parse(op.target_json) as { messageIds: number[] }).messageIds;
        const folder = op.kind === "moveToFolder" ? payload.folder! : ["archive", "notSpam"].includes(op.kind) ? undefined : null;
        if (folder !== undefined) await store.providerStore(outlook).placeMessages(ids.filter((id) => !fail.includes(id)).map((id) => ({ messageId: id, providerMsgId: providerIds.get(id)!, folder })));
        if (ids.some((id) => fail.includes(id))) await store.ops.fail(op.id, "refused", false, NOW);
        else await store.ops.complete(op.id, {}, NOW);
      }
    };
    const flagsOf = async (store: MailStore, id: number) => {
      const m = (await store.debug.snapshot()).messages.find((x) => x.id === id)!;
      return { inInbox: m.inInbox, isTrash: m.isTrash, isSpam: m.isSpam };
    };

    it("Move to Inbox, Trash and Spam out of a folder, each undone: one filing back to it, shown there at once, the Inbox part journalled; landed, a stale read can't leave it in Trash", async () => {
      const { store, outlook } = await outlookStore();
      for (const action of ["moveToInbox", "trash", "spam"] as const) {
        const m = await one(store, { accountId: outlook, providerMsgId: `in-f1-${action}`, inInbox: false, folder: "F1" });
        const acted = await store.threads.act({ threadIds: [m.thread], action, signal: null, now: NOW });
        expect(acted.before).toEqual([expect.objectContaining({ id: m.id, folder: "F1" })]);
        await land(store, outlook, new Map([[m.id, `in-f1-${action}`]]));
        expect(await list(store, outlook, "F1")).toEqual([]);
        await store.threads.restore({ messages: acted.before, now: NOW });
        // shown in the folder at once, out of the Inbox, Trash and Junk
        expect(await list(store, outlook, "F1")).toEqual([m.thread]);
        expect(await inbox(store)).toEqual([]);
        expect(await queued(store)).toEqual([{ kind: "moveToFolder", payload: { folder: "F1", from: null, keepInbox: false, ...(action === "moveToInbox" && { fromInbox: [m.id] }) }, messageIds: [m.id] }]);
        // a flag read from before the undo landed puts it back in Trash or the Inbox; the landing ends that
        if (action !== "spam") await store.sync.updateFlags(outlook, [{ messageId: m.id, expectedProviderMsgId: `in-f1-${action}`, flags: action === "trash" ? { isTrash: true, inInbox: false } : { inInbox: true } }]);
        await land(store, outlook, new Map([[m.id, `in-f1-${action}`]]));
        expect(await flagsOf(store, m.id)).toEqual({ inInbox: false, isTrash: false, isSpam: false });
        expect(await list(store, outlook, "F1")).toEqual([m.thread]);
        await store.threads.moveToFolder({ threadIds: [m.thread], accountId: outlook, folder: "F2", from: "F1", now: NOW });
        await land(store, outlook, new Map([[m.id, `in-f1-${action}`]]));
      }
    });

    it("from each role: the Inbox, Junk and Deleted Items take their own ops; Archive, Sent Items and Drafts one returnTo; a read or a star never moves", async () => {
      const { store, outlook } = await outlookStore();
      const cases = [
        { name: "inbox-archived", fields: { inInbox: true }, action: "archive", undo: { kind: "moveToInbox", payload: {} } },
        { name: "inbox-trashed", fields: { inInbox: true }, action: "trash", undo: { kind: "moveToInbox", payload: {} } },
        { name: "archive-back", fields: { inInbox: false }, action: "moveToInbox", undo: { kind: "returnTo", payload: { role: "archive" } } },
        { name: "archive-trashed", fields: { inInbox: false }, action: "trash", undo: { kind: "returnTo", payload: { role: "archive" } } },
        { name: "sent-trashed", fields: { inInbox: false, isSent: true }, action: "trash", undo: { kind: "returnTo", payload: { role: "sent" } } },
        { name: "draft-trashed", fields: { inInbox: false, isDraft: true }, action: "trash", undo: { kind: "returnTo", payload: { role: "drafts" } } },
        { name: "junk-back", fields: { inInbox: false, isSpam: true }, action: "notSpam", undo: { kind: "spam", payload: {} } },
        { name: "trash-back", fields: { inInbox: false, isTrash: true }, action: "moveToInbox", undo: { kind: "trash", payload: {} } },
      ] as const;
      for (const c of cases) {
        const m = await one(store, { accountId: outlook, providerMsgId: c.name, folder: null, ...c.fields });
        const was = await flagsOf(store, m.id);
        const acted = await store.threads.act({ threadIds: [m.thread], action: c.action, signal: null, now: NOW });
        expect(acted.before.map((s) => s.folder)).toEqual([null]);
        await land(store, outlook, new Map([[m.id, c.name]]));
        await store.threads.restore({ messages: acted.before, now: NOW });
        expect(await flagsOf(store, m.id), c.name).toEqual(was);
        expect(await queued(store), c.name).toEqual([{ ...c.undo, messageIds: [m.id] }]);
        await land(store, outlook, new Map([[m.id, c.name]]));
      }
      // a read's undo puts the read back, nothing else, even after the message moved
      const m = await one(store, { accountId: outlook, providerMsgId: "read", inInbox: false, folder: "F1" });
      const read = await store.threads.act({ threadIds: [m.thread], action: "markRead", signal: null, now: NOW });
      expect(read.before[0]!.folder).toBeUndefined();
      await land(store, outlook, new Map([[m.id, "read"]]));
      await store.threads.restore({ messages: read.before, now: NOW });
      expect((await queued(store)).map((o) => o.kind)).toEqual(["markUnread"]);
      await land(store, outlook, new Map([[m.id, "read"]]));
      // a star's undo after another app moved the message to Deleted Items (and it was read meanwhile): the star alone
      // goes, the message stays where it is now and read (review round 3 #1)
      const s = await one(store, { accountId: outlook, providerMsgId: "star", inInbox: true, folder: null });
      const starred = await store.threads.act({ threadIds: [s.thread], action: "star", signal: null, now: NOW });
      expect(starred.before[0]!.only).toBe("star");
      await land(store, outlook, new Map([[s.id, "star"]]));
      await store.sync.updateFlags(outlook, [{ messageId: s.id, expectedProviderMsgId: "star", flags: { inInbox: false, isTrash: true, isRead: true }, folder: null }]);
      await store.threads.restore({ messages: starred.before, now: NOW });
      expect(await flagsOf(store, s.id)).toEqual({ inInbox: false, isTrash: true, isSpam: false });
      const after = (await store.debug.snapshot()).messages.find((x) => x.id === s.id)!;
      expect({ isRead: after.isRead, isStarred: after.isStarred }).toEqual({ isRead: true, isStarred: false });
      expect((await queued(store)).map((o) => o.kind)).toEqual(["unstar"]);
    });

    it("undone before the action's op ran: the filing back follows it in order; several folders are one op each; IMAP's undo is unchanged", async () => {
      const { store, outlook, imap } = await outlookStore();
      const a = await one(store, { accountId: outlook, providerMsgId: "a", inInbox: false, folder: "F1" });
      const b = await one(store, { accountId: outlook, providerMsgId: "b", inInbox: false, folder: "F2" });
      const acted = await store.threads.act({ threadIds: [a.thread, b.thread], action: "moveToInbox", signal: null, now: NOW });
      expect(new Set(await inbox(store))).toEqual(new Set([a.thread, b.thread]));
      await store.threads.restore({ messages: acted.before, now: NOW });
      expect(await inbox(store)).toEqual([]);
      expect(await list(store, outlook, "F1")).toEqual([a.thread]);
      expect(await list(store, outlook, "F2")).toEqual([b.thread]);
      const ops = await queued(store);
      expect(ops[0]!.kind).toBe("moveToInbox");
      expect(ops.slice(1)).toEqual(expect.arrayContaining([
        { kind: "moveToFolder", payload: { folder: "F1", from: null, keepInbox: false, fromInbox: [a.id] }, messageIds: [a.id] },
        { kind: "moveToFolder", payload: { folder: "F2", from: null, keepInbox: false, fromInbox: [b.id] }, messageIds: [b.id] },
      ]));
      expect(ops).toHaveLength(3);
      // the queue runs the action first, then each filing back; both land where they were
      expect(await land(store, outlook, new Map([[a.id, "a"], [b.id, "b"]]))).toEqual(["moveToInbox", "moveToFolder", "moveToFolder"]);
      expect(await list(store, outlook, "F1")).toEqual([a.thread]);
      expect(await inbox(store)).toEqual([]);
      // IMAP keeps its own undo: no folder in the snapshot, no returnTo
      const i = await one(store, { accountId: imap, providerMsgId: "imap", inInbox: false, locations: [loc("A", 1)] });
      const back = await store.threads.act({ threadIds: [i.thread], action: "moveToInbox", signal: null, now: NOW });
      expect(back.before[0]!.folder).toBeUndefined();
      await store.threads.restore({ messages: back.before, now: NOW });
      expect((await queued(store)).map((o) => o.kind)).toEqual(["moveToInbox", "archive"]);
    });

    it("what's on its way counts: F, then Move to Inbox and Archive queued, then Trash is undone to Archive; a message another app moved meanwhile still goes back", async () => {
      const { store, outlook } = await outlookStore();
      const m = await one(store, { accountId: outlook, providerMsgId: "q", inInbox: false, folder: "F1" });
      await store.threads.act({ threadIds: [m.thread], action: "moveToInbox", signal: null, now: NOW });
      await store.threads.act({ threadIds: [m.thread], action: "archive", signal: null, now: NOW });
      const trashed = await store.threads.act({ threadIds: [m.thread], action: "trash", signal: null, now: NOW });
      expect(trashed.before[0]!.folder).toBeNull();
      await store.threads.restore({ messages: trashed.before, now: NOW });
      expect((await queued(store)).at(-1)).toEqual({ kind: "returnTo", payload: { role: "archive" }, messageIds: [m.id] });
      await land(store, outlook, new Map([[m.id, "q"]]));
      // filed to F1 by hand, trashed here, then moved to F2 by another app: the undo takes it back to F1
      const n = await one(store, { accountId: outlook, providerMsgId: "n", inInbox: false, folder: "F1" });
      const gone = await store.threads.act({ threadIds: [n.thread], action: "trash", signal: null, now: NOW });
      await land(store, outlook, new Map([[n.id, "n"]]));
      await store.sync.updateFlags(outlook, [{ messageId: n.id, expectedProviderMsgId: "n", flags: { isTrash: false, inInbox: false }, folder: "F2" }]);
      expect(await list(store, outlook, "F2")).toEqual([n.thread]);
      await store.threads.restore({ messages: gone.before, now: NOW });
      expect(await list(store, outlook, "F1")).toEqual([n.thread]);
      expect(await list(store, outlook, "F2")).toEqual([]);
      expect(await queued(store)).toEqual([{ kind: "moveToFolder", payload: { folder: "F1", from: null, keepInbox: false }, messageIds: [n.id] }]);
    });

    it("Codex code review: Move to Inbox out of a folder leaves it at once (#8); a trashed Junk message is out of Junk (#1); a filing on its way under a stale Inbox read keeps its folder (#2); a part that landed is cleared of a stale Trash read though the rest failed (#6)", async () => {
      const { store, outlook } = await outlookStore();
      const f = await one(store, { accountId: outlook, providerMsgId: "f", inInbox: false, folder: "F1" });
      await store.threads.act({ threadIds: [f.thread], action: "moveToInbox", signal: null, now: NOW });
      expect(await list(store, outlook, "F1")).toEqual([]);
      expect(await inbox(store)).toEqual([f.thread]);
      await land(store, outlook, new Map([[f.id, "f"]]));
      // #1: trashed out of Junk, then back to the Inbox, then that undone: back to Deleted Items, not on to Junk
      const j = await one(store, { accountId: outlook, providerMsgId: "j", inInbox: false, isSpam: true, folder: null });
      await store.threads.act({ threadIds: [j.thread], action: "trash", signal: null, now: NOW });
      expect(await flagsOf(store, j.id)).toEqual({ inInbox: false, isTrash: true, isSpam: false });
      const back = await store.threads.act({ threadIds: [j.thread], action: "moveToInbox", signal: null, now: NOW });
      await land(store, outlook, new Map([[j.id, "j"], [f.id, "f"]]));
      await store.threads.restore({ messages: back.before, now: NOW });
      expect(await queued(store)).toEqual([{ kind: "trash", payload: {}, messageIds: [j.id] }]);
      await land(store, outlook, new Map([[j.id, "j"]]));
      // #2: filed from the Inbox, a read from before the filing puts it back in the Inbox, then trashed and undone
      await store.threads.moveToFolder({ threadIds: [f.thread], accountId: outlook, folder: "F2", from: null, now: NOW });
      await store.sync.updateFlags(outlook, [{ messageId: f.id, expectedProviderMsgId: "f", flags: { inInbox: true }, folder: null }]);
      const trashed = await store.threads.act({ threadIds: [f.thread], action: "trash", signal: null, now: NOW });
      expect(trashed.before[0]!.folder).toBe("F2");
      await land(store, outlook, new Map([[f.id, "f"]]));
      await store.threads.restore({ messages: trashed.before, now: NOW });
      expect(await queued(store)).toEqual([{ kind: "moveToFolder", payload: { folder: "F2", from: null, keepInbox: false }, messageIds: [f.id] }]);
      // round 2 #4: back in its folder at once, and only there: the stale Inbox flag it was saved with isn't restored
      expect(await flagsOf(store, f.id)).toEqual({ inInbox: false, isTrash: false, isSpam: false });
      expect(await inbox(store)).toEqual([]);
      expect(await list(store, outlook, "F2")).toEqual([f.thread]);
      await land(store, outlook, new Map([[f.id, "f"]]));
      expect(await list(store, outlook, "F2")).toEqual([f.thread]);
      // #6: two trashed out of F1 and undone; a stale read puts the first back in Trash; it lands, the second is refused
      const a = await one(store, { accountId: outlook, providerMsgId: "sa", inInbox: false, folder: "F1" });
      const b = await one(store, { accountId: outlook, providerMsgId: "sb", inInbox: false, folder: "F1" });
      const ids = new Map([[a.id, "sa"], [b.id, "sb"]]);
      const both = await store.threads.act({ threadIds: [a.thread, b.thread], action: "trash", signal: null, now: NOW });
      await land(store, outlook, ids);
      await store.threads.restore({ messages: both.before, now: NOW });
      await store.sync.updateFlags(outlook, [{ messageId: a.id, expectedProviderMsgId: "sa", flags: { isTrash: true }, folder: null }]);
      await land(store, outlook, ids, [b.id]);
      expect(await flagsOf(store, a.id)).toEqual({ inInbox: false, isTrash: false, isSpam: false });
      expect(await list(store, outlook, "F1")).toEqual([a.thread]);
    });

    it("a returnTo queued before the account's flag clock exists owns the three location flags once it starts: a read on its way can't put the message back in the Inbox", async () => {
      const { store, outlook } = await outlookStore();
      const m = await one(store, { accountId: outlook, providerMsgId: "early", inInbox: false, folder: null });
      const acted = await store.threads.act({ threadIds: [m.thread], action: "moveToInbox", signal: null, now: NOW });
      await land(store, outlook, new Map([[m.id, "early"]]));
      await store.threads.restore({ messages: acted.before, now: NOW });
      expect((await queued(store)).map((o) => o.kind)).toEqual(["returnTo"]);
      const observation = await store.sync.beginObservation?.(outlook, { authoritativeFlags: true });
      if (!observation) return;
      await store.sync.updateFlags(outlook, [{ messageId: m.id, expectedProviderMsgId: "early", flags: { inInbox: true, isTrash: false, isSpam: false }, folder: null }], observation);
      expect(await flagsOf(store, m.id)).toEqual({ inInbox: false, isTrash: false, isSpam: false });
      expect(await inbox(store)).toEqual([]);
    });

    it("an undo landing for part only: what landed stays in the folder, the rest comes back to the Inbox, and where each is is read again", async () => {
      const { store, outlook } = await outlookStore();
      const observe = (await store.sync.beginObservation?.(outlook, { authoritativeFlags: true })) ?? null;
      const a = await one(store, { accountId: outlook, providerMsgId: "pa", inInbox: false, folder: "F1" });
      const b = await one(store, { accountId: outlook, providerMsgId: "pb", inInbox: false, folder: "F1" });
      const ids = new Map([[a.id, "pa"], [b.id, "pb"]]);
      const acted = await store.threads.act({ threadIds: [a.thread, b.thread], action: "moveToInbox", signal: null, now: NOW });
      await land(store, outlook, ids);
      const snapshots = async () => (await store.providerStore(outlook).pendingFlagSnapshots({ limit: 50 })).items.map((i) => i.id).sort();
      if (observe) {
        // the action's own snapshots, read: nothing else asks
        await store.sync.updateFlags(outlook, [a, b].map((m) => ({ messageId: m.id, expectedProviderMsgId: ids.get(m.id)!, flags: { inInbox: true, isTrash: false, isSpam: false }, folder: null })), (await store.sync.beginObservation!(outlook, { authoritativeFlags: true }))!);
        expect(await snapshots()).toEqual([]);
      }
      await store.threads.restore({ messages: acted.before, now: NOW });
      await land(store, outlook, ids, [b.id]);
      expect(await list(store, outlook, "F1")).toEqual([a.thread]);
      expect(await inbox(store)).toEqual([b.thread]);
      if (observe) expect(await snapshots()).toEqual([a.id, b.id].sort());
    });
  });
}
