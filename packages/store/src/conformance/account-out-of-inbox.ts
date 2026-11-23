import { describe, expect, it } from "vitest";
import type { MailStore } from "../mail-store";
import { ingest, msg, threadOf, withAccounts } from "./fixtures";

const NOW = Date.UTC(2026, 10, 22, 12);
const DAY = 86_400_000;
const addr = (email: string, name = "") => ({ name, email });

/**
 * Plan 238: an account out of the all-accounts Inbox. That Inbox (its pages,
 * filters, kept rows, scopes and the total counts) leaves out its threads;
 * its own Inbox, its count, every other view and notifications keep them.
 */
export function defineAccountOutOfInboxConformance(fresh: () => Promise<MailStore>, reopen: (store: MailStore) => Promise<MailStore>): void {
  describe("an account out of the all-accounts Inbox (plan 238)", () => {
    async function setup() {
      const store = await fresh();
      const [a, b] = await withAccounts(store, 2);
      const thread = async (pid: string, accountId: number, date: number, over: Partial<Parameters<typeof msg>[0]> = {}) => {
        await ingest(store, [msg({ accountId, providerMsgId: pid, from: addr(`${pid}@corp.io`), date, ...over })]);
        return threadOf(store, pid);
      };
      const a1 = await thread("a1", a!, NOW - 5 * DAY);
      const b1 = await thread("b1", b!, NOW - 4 * DAY);
      const b2 = await thread("b2", b!, NOW - 3 * DAY, { isRead: true });
      const a2 = await thread("a2", a!, NOW - 2 * DAY, { isRead: true });
      const b3 = await thread("b3", b!, NOW - DAY);
      return { store, a: a!, b: b!, a1, a2, b1, b2, b3 };
    }
    const ids = async (store: MailStore, p: Parameters<MailStore["threads"]["list"]>[0]) => (await store.threads.list(p)).items.map((t) => t.id);

    it("the switch round-trips, keeps the account's other preferences and survives a reopen", async () => {
      const { store: s, a, b } = await setup();
      expect((await s.accounts.list()).map((x) => x.unified)).toEqual([true, true]);
      await s.accounts.update(b, { senderName: "Bea" });
      expect(await s.accounts.update(b, { unified: false })).toMatchObject({ id: b, unified: false, senderName: "Bea" });
      const store = await reopen(s);
      expect((await store.accounts.list()).map((x) => [x.id, x.unified])).toEqual([[a, true], [b, false]]);
      expect(await store.accounts.update(b, { unified: true })).toMatchObject({ unified: true, senderName: "Bea" });
    });

    it("the all-accounts Inbox's pages, filters, kept rows, scopes and total counts leave it out; its own Inbox and count keep it", async () => {
      const { store, a, b, a1, a2, b1, b2, b3 } = await setup();
      expect(await ids(store, { view: "inbox", limit: 10 })).toEqual([b3, a2, b2, b1, a1]);
      expect((await store.threads.counts(NOW)).inboxUnread).toBe(3);

      await store.accounts.update(b, { unified: false });
      expect(await ids(store, { view: "inbox", limit: 10 })).toEqual([a2, a1]);
      // a page boundary with its rows between: the cursor walks past them
      const first = await store.threads.list({ view: "inbox", limit: 1 });
      expect(first.items.map((t) => t.id)).toEqual([a2]);
      expect(await ids(store, { view: "inbox", limit: 10, cursor: first.nextCursor! })).toEqual([a1]);
      expect(await ids(store, { view: "inbox", filter: "unread", limit: 10 })).toEqual([a1]);
      // a row the unread filter keeps (just read) stays only if this Inbox shows it
      expect(await ids(store, { view: "inbox", filter: "unread", keepIds: [a2, b2], limit: 10 })).toEqual([a2, a1]);
      expect(await store.threads.scopeIds({ view: "inbox", limit: 10 })).toEqual([a1, a2]);
      expect(await store.threads.scopeCount({ view: "inbox", limit: 10 })).toBe(2);
      expect(await store.threads.scopeIds({ view: "inbox", filter: "unread", limit: 10 })).toEqual([a1]);
      const counts = await store.threads.counts(NOW);
      expect(counts.inboxUnread).toBe(1);
      expect(counts.inboxUnreadByAccount[a]).toBe(1);
      expect(counts.inboxUnreadByAccount[b]).toBe(2);

      // its own Inbox: everything, its unread filter and its Mark all as read's scope (plan 106) too
      expect(await ids(store, { view: "inbox", accountId: b, limit: 10 })).toEqual([b3, b2, b1]);
      expect(await ids(store, { view: "inbox", accountId: b, filter: "unread", limit: 10 })).toEqual([b3, b1]);
      expect(await store.threads.scopeIds({ view: "inbox", accountId: b, filter: "unread", limit: 10 })).toEqual([b1, b3]);
      expect(await store.threads.scopeCount({ view: "inbox", accountId: b, limit: 10 })).toBe(3);
      // the other views across accounts keep it
      expect(await ids(store, { view: "all", limit: 10 })).toEqual([b3, a2, b2, b1, a1]);
      expect(await store.threads.scopeCount({ view: "all", limit: 10 })).toBe(5);

      await store.accounts.update(b, { unified: true });
      expect(await ids(store, { view: "inbox", limit: 10 })).toEqual([b3, a2, b2, b1, a1]);
      expect((await store.threads.counts(NOW)).inboxUnread).toBe(3);
    });

    it("every account out: the all-accounts Inbox is empty and counts nothing; each keeps its own", async () => {
      const { store, a, b } = await setup();
      await store.accounts.update(a, { unified: false });
      await store.accounts.update(b, { unified: false });
      expect(await ids(store, { view: "inbox", limit: 10 })).toEqual([]);
      expect(await store.threads.scopeCount({ view: "inbox", limit: 10 })).toBe(0);
      const counts = await store.threads.counts(NOW);
      expect(counts.inboxUnread).toBe(0);
      expect(counts.inboxUnreadByAccount).toMatchObject({ [a]: 1, [b]: 2 });
    });

    it("with a category hidden from the Inbox too: both rules hold, and the account's own Inbox still hides the category", async () => {
      const { store, a, b, a1, a2, b1, b3 } = await setup();
      const quiet = (await store.categories.create("Quiet", "slate", { showInInbox: false })).id;
      await store.categories.add({ categoryId: quiet, threadIds: [a1, b3], addedBy: "user", now: NOW });
      await store.accounts.update(b, { unified: false });
      expect(await ids(store, { view: "inbox", limit: 10 })).toEqual([a2]);
      expect((await store.threads.counts(NOW)).inboxUnread).toBe(0);
      expect((await store.threads.counts(NOW)).inboxUnreadByAccount[b]).toBe(1);
      expect(await ids(store, { view: "inbox", accountId: b, filter: "unread", limit: 10 })).toEqual([b1]);
      expect(await ids(store, { view: "inbox", accountId: a, limit: 10 })).toEqual([a2]);
    });

    it("Waiting's page, scope and total count leave it out; its own count keeps it", async () => {
      const store = await fresh();
      const [a, b] = await withAccounts(store, 2);
      await ingest(store, [
        msg({ accountId: a!, providerMsgId: "wa", rfcMessageId: "wa@x", from: addr("carlos@acme.com", "Carlos"), to: [addr("me0@example.com", "Me")], date: NOW - DAY }),
        msg({ accountId: b!, providerMsgId: "wb", rfcMessageId: "wb@x", from: addr("maria@acme.com", "María"), to: [addr("me1@example.com", "Me")], date: NOW - 2 * DAY }),
      ]);
      const wa = await threadOf(store, "wa");
      expect((await store.threads.counts(NOW)).inboxWaiting).toBe(2);
      await store.accounts.update(b!, { unified: false });
      expect(await ids(store, { view: "inbox", filter: "waiting", now: NOW, limit: 10 })).toEqual([wa]);
      expect(await store.threads.scopeIds({ view: "inbox", filter: "waiting", now: NOW, limit: 10 })).toEqual([wa]);
      expect(await store.threads.scopeCount({ view: "inbox", filter: "waiting", now: NOW, limit: 10 })).toBe(1);
      const counts = await store.threads.counts(NOW);
      expect(counts.inboxWaiting).toBe(1);
      expect(counts.inboxWaitingByAccount?.[b!]).toBe(1);
      expect(await ids(store, { view: "inbox", accountId: b!, filter: "waiting", now: NOW, limit: 10 })).toHaveLength(1);
    });

    it("its arrivals are still Inbox mail (its own Inbox has them: notifications go on)", async () => {
      const { store, b } = await setup();
      await store.accounts.update(b, { unified: false });
      const r = await ingest(store, [msg({ accountId: b, providerMsgId: "b-new", from: addr("ana@corp.io"), date: NOW - 60_000 })]);
      expect((await store.sync.arrivals(r.inserted)).map((x) => x.inInbox)).toEqual([true]);
    });
  });
}
