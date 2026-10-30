import { afterEach, describe, expect, it } from "vitest";
import { REMOVABLE_BUCKETS, storageCutoff, type StorageThreadRow } from "@terno/core";
import type { MailStore } from "../mail-store";
import type { StoreHarness } from "./store";
import { ingest, msg, threadOf, withAccounts } from "./fixtures";

const NOW = Date.UTC(2026, 9, 29, 12);
const DAY = 86_400_000;
const CUTOFF = storageCutoff(NOW, 365);
const OLD = NOW - 400 * DAY;
const ALL = [...REMOVABLE_BUCKETS];

/**
 * Plan 69: the storage report's rows and removing this device's copy of old conversations. What may never go
 * (starred, replied, drafted, local, unsettled, signed out) stays, re-checked in the unit that removes; removal is
 * bounded by messages, durable, and frees what only it pinned.
 */
export function defineStorageConformance(name: string, h: StoreHarness): void {
  let store: MailStore;
  afterEach(async () => store?.isOpen && store.close());
  /** accounts that finished a sync (one that never did keeps its mail: that's a test of its own) */
  const fresh = async () => {
    store = await h.open();
    const ids = await withAccounts(store);
    for (const id of ids) await store.accounts.setSyncState(id, { lastSyncAt: NOW });
    return ids;
  };
  const rows = async () => {
    const out: StorageThreadRow[] = [];
    for (let after = 0; ; ) {
      const page = await store.storage.threads(after, 2);
      if (!page.length) return out;
      out.push(...page);
      after = page.at(-1)!.id;
    }
  };
  const rowOf = async (providerMsgId: string) => {
    const id = await threadOf(store, providerMsgId);
    return (await rows()).find((r) => r.id === id)!;
  };
  const removeAll = async (threadIds: number[], maxMessages = 1000) => {
    let total = { threads: 0, messages: 0 };
    for (;;) {
      const r = await store.storage.remove({ threadIds, buckets: ALL, cutoff: CUTOFF, maxMessages });
      total = { threads: total.threads + r.threads, messages: total.messages + r.messages };
      if (!r.remaining || !r.messages) return { ...total, remaining: r.remaining };
    }
  };

  describe(`storage (plan 69): ${name}`, () => {
    it("reads every conversation once, ascending, with its view, age, messages and size", async () => {
      const [a] = await fresh();
      // what a message takes grows with what it holds, measured or the provider's word for it (both scale here)
      const big = "x".repeat(50_000);
      await ingest(store, [
        msg({ accountId: a!, providerMsgId: "inbox", date: OLD, size: 100, bodyText: "short" }),
        msg({ accountId: a!, providerMsgId: "archive", inInbox: false, date: OLD, size: 50_000, bodyText: big }),
        msg({ accountId: a!, providerMsgId: "spam", inInbox: false, isSpam: true, date: OLD }),
        msg({ accountId: a!, providerMsgId: "trash", inInbox: false, isTrash: true, isSpam: true, date: OLD }),
        msg({ accountId: a!, providerMsgId: "sent", inInbox: false, isSent: true, from: { name: "Me", email: "me0@example.com" }, date: OLD }),
        msg({ accountId: a!, providerMsgId: "young", isSpam: true, inInbox: false, date: NOW - 3 * DAY }),
      ]);
      const all = await rows();
      expect(all.map((r) => r.id)).toEqual(all.map((r) => r.id).sort((x, y) => x - y));
      expect(new Set(all.map((r) => r.id)).size).toBe(6);
      const inbox = await rowOf("inbox");
      expect(inbox).toMatchObject({ accountId: a, bucket: "inbox", lastDate: OLD, kept: false, messages: 1 });
      const archive = await rowOf("archive");
      expect(archive).toMatchObject({ bucket: "archive" });
      expect(inbox.bytes).toBeGreaterThan(0);
      expect(archive.bytes).toBeGreaterThan(40_000);
      expect(archive.bytes).toBeGreaterThan(50 * inbox.bytes);
      expect(await rowOf("spam")).toMatchObject({ bucket: "spam" });
      // trash wins over spam; a conversation you wrote in is Sent, and kept
      expect(await rowOf("trash")).toMatchObject({ bucket: "trash" });
      expect(await rowOf("sent")).toMatchObject({ bucket: "sent", kept: true });
      expect(await rowOf("young")).toMatchObject({ bucket: "spam", lastDate: NOW - 3 * DAY, kept: false });
      expect(await store.storage.threads(0, 0)).toEqual([]);
    });

    it("keeps what must stay: starred, replied, a draft on it or on one of its messages, unsettled changes, a signed-out account", async () => {
      const [a, b] = await fresh();
      const old = (id: string, over: Partial<Parameters<typeof msg>[0]> = {}) => msg({ accountId: a!, providerMsgId: id, inInbox: false, isSpam: true, date: OLD, ...over });
      await ingest(store, [
        old("plain"),
        old("starred", { isStarred: true }),
        // the thread's own star ignores Trash; the message's still counts
        old("starred-trash", { isStarred: true, isTrash: true }),
        old("drafted"),
        old("forwarded"),
        old("queued"),
        msg({ accountId: b!, providerMsgId: "signed-out", inInbox: false, isSpam: true, date: OLD }),
      ]);
      await store.drafts.save({ accountId: a!, threadId: await threadOf(store, "drafted"), to: [], cc: [], subject: "re", bodyText: "half a reply" }, NOW);
      const forwarded = (await store.threads.get(await threadOf(store, "forwarded")))!.messages[0]!.id;
      await store.drafts.save({ accountId: a!, to: [], cc: [], subject: "fwd", bodyText: "", forwardOfMessageId: forwarded }, NOW);
      await store.threads.act({ threadIds: [await threadOf(store, "queued")], action: "markRead", signal: null, now: NOW });
      await store.accounts.setSyncState(b!, { authRequired: true });
      for (const id of ["starred", "starred-trash", "drafted", "forwarded", "queued", "signed-out"]) expect({ id, kept: (await rowOf(id)).kept }).toEqual({ id, kept: true });
      expect((await rowOf("plain")).kept).toBe(false);
      // only sending refused: the mailbox itself still syncs, so its mail may go
      await store.accounts.setSyncState(b!, { authRequired: true, authScope: "send" });
      expect((await rowOf("signed-out")).kept).toBe(false);
    });

    it("keeps what Trash and Spam hide from the thread's flags: a message you sent, a star (Codex code review #1)", async () => {
      const [a] = await fresh();
      const root = msg({ accountId: a!, providerMsgId: "asked", rfcMessageId: "asked@t", inInbox: false, isTrash: true, date: OLD });
      await ingest(store, [root, msg({ accountId: a!, providerMsgId: "answered", rfcMessageId: "answered@t", inReplyTo: "asked@t", references: ["asked@t"], subject: root.subject, from: { name: "Me", email: "me0@example.com" }, isSent: true, inInbox: false, isTrash: true, date: OLD + 1 })]);
      const t = await threadOf(store, "asked");
      expect(await rowOf("asked")).toMatchObject({ bucket: "trash", kept: true });
      expect((await store.storage.remove({ threadIds: [t], buckets: ["trash"], cutoff: CUTOFF, maxMessages: 10 })).messages).toBe(0);
    });

    it("dates a conversation by its newest message of any kind, Trash's too (Codex code review #2)", async () => {
      const [a] = await fresh();
      const root = msg({ accountId: a!, providerMsgId: "kept-old", rfcMessageId: "kept-old@t", inInbox: false, date: OLD });
      await ingest(store, [root, msg({ accountId: a!, providerMsgId: "new-trashed", rfcMessageId: "new-trashed@t", inReplyTo: "kept-old@t", references: ["kept-old@t"], subject: root.subject, inInbox: false, isTrash: true, date: NOW - DAY })]);
      const t = await threadOf(store, "kept-old");
      expect((await rowOf("kept-old")).lastDate).toBe(NOW - DAY);
      expect((await store.storage.remove({ threadIds: [t], buckets: ["archive", "trash"], cutoff: CUTOFF, maxMessages: 10 })).messages).toBe(0);
      expect((await store.threads.get(t))!.messages).toHaveLength(2);
    });

    it("keeps the mail of an account that never finished a sync (Codex R2, code review #3)", async () => {
      store = await h.open();
      const [a] = await withAccounts(store, 1);
      await ingest(store, [msg({ accountId: a!, providerMsgId: "unsynced", inInbox: false, isSpam: true, date: OLD })]);
      expect((await rowOf("unsynced")).kept).toBe(true);
      await store.accounts.setSyncState(a!, { lastSyncAt: NOW });
      expect((await rowOf("unsynced")).kept).toBe(false);
    });

    it("finishes a conversation it began even when removing its oldest message moves it to another view (Codex code review #5)", async () => {
      const [a] = await fresh();
      // the oldest message is the one in the Inbox: the thread is Inbox until it goes, then Archive
      const root = msg({ accountId: a!, providerMsgId: "inbox-root", rfcMessageId: "inbox-root@t", inInbox: true, date: OLD });
      await ingest(store, [root, ...[1, 2, 3].map((i) => msg({ accountId: a!, providerMsgId: `arch${i}`, rfcMessageId: `arch${i}@t`, inReplyTo: "inbox-root@t", references: ["inbox-root@t"], subject: root.subject, inInbox: false, date: OLD + i }))]);
      const t = await threadOf(store, "inbox-root");
      const first = await store.storage.remove({ threadIds: [t], buckets: ["inbox"], cutoff: CUTOFF, maxMessages: 1 });
      expect(first).toMatchObject({ messages: 1, remaining: 3, partial: [t] });
      expect((await rowOf("arch1")).bucket).toBe("archive");
      // a fresh look refuses it (Archive wasn't chosen); the removal that began it goes on
      expect((await store.storage.remove({ threadIds: [t], buckets: ["inbox"], cutoff: CUTOFF, maxMessages: 10 })).messages).toBe(0);
      expect(await store.storage.remove({ threadIds: [t], buckets: ["inbox"], cutoff: CUTOFF, maxMessages: 10, continuing: [t] })).toMatchObject({ messages: 3, threads: 1, partial: [] });
      expect(await store.threads.get(t)).toBeNull();
    });

    it("keeps a change the server took but hasn't confirmed yet (op settled, snapshot pending: Codex R4)", async () => {
      const [a] = await fresh();
      await ingest(store, [msg({ accountId: a!, providerMsgId: "settled", inInbox: false, isSpam: true, date: OLD })]);
      const t = await threadOf(store, "settled");
      await store.sync.beginObservation(a!, { authoritativeFlags: true });
      await store.threads.act({ threadIds: [t], action: "markRead", signal: null, now: NOW });
      const [op] = await store.ops.claimReady(NOW + 1, 10);
      await store.ops.complete(op!.id, undefined, NOW + 2);
      expect((await store.ops.get(op!.id))?.state).toBe("succeeded");
      expect((await store.providerStore(a!).pendingFlagSnapshots({ limit: 50 })).items.length).toBeGreaterThan(0);
      expect((await rowOf("settled")).kept).toBe(true);
      expect((await store.storage.remove({ threadIds: [t], buckets: ["spam"], cutoff: CUTOFF, maxMessages: 10 })).messages).toBe(0);
      // the server's word arrives: nothing is pending any more, so it may go
      const confirmed = (await store.sync.beginObservation(a!, { authoritativeFlags: true }))!;
      const id = (await store.threads.get(t))!.messages[0]!.id;
      await store.sync.updateFlags(a!, [{ messageId: id, expectedProviderMsgId: "settled", flags: { isRead: true } }], confirmed);
      expect((await store.providerStore(a!).pendingFlagSnapshots({ limit: 50 })).items).toEqual([]);
      expect((await rowOf("settled")).kept).toBe(false);
    });

    it("removes only what passes now: re-checked in the unit (a star meanwhile stays), young and unchosen views stay", async () => {
      const [a] = await fresh();
      await ingest(store, [
        msg({ accountId: a!, providerMsgId: "s1", inInbox: false, isSpam: true, date: OLD }),
        msg({ accountId: a!, providerMsgId: "s2", inInbox: false, isSpam: true, date: OLD }),
        msg({ accountId: a!, providerMsgId: "young", inInbox: false, isSpam: true, date: NOW - DAY }),
        msg({ accountId: a!, providerMsgId: "inbox", date: OLD }),
      ]);
      const [s1, s2, young, inbox] = await Promise.all(["s1", "s2", "young", "inbox"].map((id) => threadOf(store, id)));
      // starred after the report was read: the unit sees it
      await store.threads.act({ threadIds: [s2!], action: "star", signal: null, now: NOW });
      const r = await store.storage.remove({ threadIds: [s1!, s2!, young!, inbox!], buckets: ["spam"], cutoff: CUTOFF, maxMessages: 100 });
      expect(r).toMatchObject({ threads: 1, messages: 1, remaining: 0 });
      expect(r.touched).toContain(s1);
      expect(r.removed).toEqual([{ accountId: a, providerMsgIds: ["s1"] }]);
      expect(await store.threads.get(s1!)).toBeNull();
      for (const t of [s2, young, inbox]) expect(await store.threads.get(t!)).not.toBeNull();
      expect((await store.threads.list({ view: "spam", limit: 50, now: NOW })).items.map((t) => t.id).sort()).toEqual([s2, young].sort());
      // search forgets it too
      expect((await store.threads.searchText({ query: "Subject", limit: 50, now: NOW })).items.map((t) => t.id)).not.toContain(s1);
      await store.debug.verify();
    });

    it("bounds a unit by messages, oldest first: a large conversation takes several and stays old until it is gone", async () => {
      const [a] = await fresh();
      const root = msg({ accountId: a!, providerMsgId: "big0", rfcMessageId: "big0@test", inInbox: false, isSpam: true, date: OLD });
      const replies = [1, 2, 3, 4].map((i) => msg({ accountId: a!, providerMsgId: `big${i}`, rfcMessageId: `big${i}@test`, inReplyTo: "big0@test", references: ["big0@test"], subject: root.subject, inInbox: false, isSpam: true, date: OLD + i * 1000 }));
      await ingest(store, [root, ...replies]);
      const t = await threadOf(store, "big0");
      expect((await rowOf("big0")).messages).toBe(5);
      const first = await store.storage.remove({ threadIds: [t], buckets: ["spam"], cutoff: CUTOFF, maxMessages: 2 });
      expect(first).toMatchObject({ threads: 0, messages: 2, remaining: 3 });
      expect(first.removed[0]!.providerMsgIds).toEqual(["big0", "big1"]);
      expect(await rowOf("big4")).toMatchObject({ messages: 3, lastDate: OLD + 4000 });
      expect(await removeAll([t], 2)).toEqual({ threads: 1, messages: 3, remaining: 0 });
      expect(await store.threads.get(t)).toBeNull();
      await store.debug.verify();
    });

    it("is durable, and frees the attachments only it pinned (a draft's stay)", async () => {
      const [a] = await fresh();
      const part = { filename: "a.bin", mime: "application/octet-stream", size: 3, bytes: new Uint8Array([1, 2, 3]) };
      await ingest(store, [msg({ accountId: a!, providerMsgId: "files", inInbox: false, isSpam: true, date: OLD, attachments: [part] })]);
      const t = await threadOf(store, "files");
      const asset = (await store.threads.get(t))!.messages[0]!.attachments[0]!.assetId!;
      const kept = await store.attachments.create({ accountId: a!, filename: "mine.txt", mime: "text/plain", size: 3, now: NOW });
      await store.attachments.append(a!, kept.assetId, 0, "AP+A");
      await store.attachments.seal(a!, kept.assetId);
      await store.drafts.save({ accountId: a!, to: [], cc: [], subject: "mine", bodyText: "", attachments: [kept] }, NOW);
      expect(await removeAll([t])).toMatchObject({ threads: 1, messages: 1 });
      store = await h.reopen(store);
      expect(await store.threads.get(t)).toBeNull();
      let units = 0;
      while (await store.storage.collect(NOW)) expect(++units).toBeLessThan(50);
      await expect(store.attachments.info(a!, asset)).rejects.toThrow();
      expect(await store.attachments.read(a!, kept.assetId, 0)).toBe("AP+A");
      expect(await store.storage.collect(NOW)).toBe(false);
      await store.debug.verify();
    });

    it("measures itself and gives freed pages back (now, or on the next open where only that can)", async () => {
      const [a] = await fresh();
      const big = "x".repeat(4000);
      await ingest(store, Array.from({ length: 300 }, (_, i) => msg({ accountId: a!, providerMsgId: `bulk${i}`, inInbox: false, isTrash: true, date: OLD, bodyText: big })));
      const ids = (await rows()).map((r) => r.id);
      const before = await store.storage.footprint();
      expect(before === null || (before.bytes > 0 && before.free >= 0)).toBe(true);
      expect(await removeAll(ids)).toMatchObject({ threads: 300, messages: 300 });
      let onRestart = false;
      for (let i = 0; ; i++) {
        const c = await store.storage.compact(64);
        onRestart ||= c.onRestart;
        if (!c.more) break;
        expect(i).toBeLessThan(1000);
      }
      const after = await store.storage.footprint();
      if (after && !onRestart) expect(after.free).toBe(0);
      expect(await store.storage.compactPending()).toBe(onRestart);
      if (before && after && !onRestart) expect(after.bytes).toBeLessThan(before.bytes + 1);
    });
  });
}
