import { folderRef } from "@terno/core";
import { afterEach, describe, expect, it } from "vitest";
import type { MailStore } from "../mail-store";
import { ingest, msg, threadOf, withAccounts } from "./fixtures";
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
      const hidden = (await store.categories.create("Hidden", "indigo", { showInInbox: false })).id;
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
}
