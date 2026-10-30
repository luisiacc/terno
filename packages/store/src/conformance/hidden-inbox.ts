import { describe, expect, it } from "vitest";
import type { MailStore } from "../mail-store";
import { ingest, msg, threadOf, withAccounts } from "./fixtures";

const NOW = Date.UTC(2026, 9, 22, 15, 30);
const DAY = 86_400_000;
const addr = (email: string, name = "") => ({ name, email });

/**
 * Plan 80: a category hidden from the Inbox. The plain Inbox (its pages, quick
 * filters, kept rows, scopes and counts) leaves out every thread in a hidden
 * category; the category's own list, its tab of an account's Inbox (plan 67)
 * and its counts keep them; notifications don't screen them as Inbox mail.
 */
export function defineHiddenInboxConformance(fresh: () => Promise<MailStore>, reopen: (store: MailStore) => Promise<MailStore>): void {
  describe("categories hidden from the Inbox (plan 80)", () => {
    async function setup() {
      const store = await fresh();
      const [a, b] = await withAccounts(store, 2);
      const linkedin = (await store.categories.create("LinkedIn", "cyan")).id;
      const work = (await store.categories.create("Work", "indigo")).id;
      const thread = async (pid: string, over: Partial<Parameters<typeof msg>[0]> = {}) => {
        await ingest(store, [msg({ accountId: a!, providerMsgId: pid, date: NOW - DAY, ...over })]);
        return threadOf(store, pid);
      };
      const li = await thread("li", { from: addr("jobs@linkedin.com"), date: NOW - 5 * DAY });
      const both = await thread("both", { accountId: b!, from: addr("news@linkedin.com"), date: NOW - 4 * DAY });
      const w = await thread("w", { from: addr("boss@acme.com"), date: NOW - 3 * DAY });
      const plain = await thread("plain", { from: addr("ana@friends.com"), isRead: true, date: NOW - 2 * DAY });
      await store.categories.add({ categoryId: linkedin, threadIds: [li, both], addedBy: "user", now: NOW });
      await store.categories.add({ categoryId: work, threadIds: [both, w], addedBy: "user", now: NOW });
      return { store, a: a!, b: b!, linkedin, work, li, both, w, plain };
    }
    const ids = async (store: MailStore, p: Parameters<MailStore["threads"]["list"]>[0]) => (await store.threads.list(p)).items.map((t) => t.id);

    it("new and existing categories show in the Inbox; the setting round-trips and survives a reopen", async () => {
      const { store: s, linkedin, work } = await setup();
      expect((await s.categories.list()).map((c) => c.showInInbox)).toEqual([true, true]);
      expect(await s.categories.update(linkedin, { showInInbox: false })).toMatchObject({ id: linkedin, showInInbox: false });
      const store = await reopen(s);
      expect((await store.categories.list()).map((c) => [c.id, c.showInInbox])).toEqual([[linkedin, false], [work, true]]);
    });

    it("the Inbox's pages, filters, kept rows, scopes and counts leave out a hidden category's threads; hidden wins over shown", async () => {
      const { store, a, b, linkedin, work, li, both, w, plain } = await setup();
      expect(await ids(store, { view: "inbox", limit: 10 })).toEqual([plain, w, both, li]);
      expect((await store.threads.counts(NOW)).inboxUnread).toBe(3);

      await store.categories.update(linkedin, { showInInbox: false });
      expect(await ids(store, { view: "inbox", limit: 10 })).toEqual([plain, w]);
      // a page boundary inside the hidden rows: the cursor walks past them
      const first = await store.threads.list({ view: "inbox", limit: 1 });
      expect(first.items.map((t) => t.id)).toEqual([plain]);
      expect(await ids(store, { view: "inbox", limit: 10, cursor: first.nextCursor! })).toEqual([w]);
      expect(await ids(store, { view: "inbox", filter: "unread", limit: 10 })).toEqual([w]);
      expect(await ids(store, { view: "inbox", accountId: a, limit: 10 })).toEqual([plain, w]);
      expect(await ids(store, { view: "inbox", accountId: b, limit: 10 })).toEqual([]);
      // a row the unread filter keeps (just read) stays only if the Inbox shows it
      expect(await ids(store, { view: "inbox", filter: "unread", keepIds: [plain, li], limit: 10 })).toEqual([plain, w]);
      expect(await store.threads.scopeIds({ view: "inbox", limit: 10 })).toEqual([w, plain].sort((x, y) => x - y));
      expect(await store.threads.scopeCount({ view: "inbox", limit: 10 })).toBe(2);
      expect(await store.threads.scopeIds({ view: "inbox", filter: "unread", limit: 10 })).toEqual([w]);
      const counts = await store.threads.counts(NOW);
      expect(counts.inboxUnread).toBe(1);
      expect(counts.inboxUnreadByAccount[a] ?? 0).toBe(1);
      expect(counts.inboxUnreadByAccount[b] ?? 0).toBe(0);

      // where the mail lives now: its category's list and count, its tab of an account's Inbox, other views
      expect(await ids(store, { view: "all", categoryId: linkedin, limit: 10 })).toEqual([both, li]);
      expect(await ids(store, { view: "inbox", categoryId: linkedin, accountId: a, limit: 10 })).toEqual([li]);
      expect(await ids(store, { view: "all", categoryId: work, limit: 10 })).toEqual([w, both]);
      expect(await ids(store, { view: "all", limit: 10 })).toEqual([plain, w, both, li]);
      expect(await store.threads.scopeCount({ view: "all", categoryId: linkedin, limit: 10 })).toBe(2);
      expect(counts.categoryUnread[linkedin]).toBe(2);

      // shown again: everything is back
      await store.categories.update(linkedin, { showInInbox: true });
      expect(await ids(store, { view: "inbox", limit: 10 })).toEqual([plain, w, both, li]);
      expect((await store.threads.counts(NOW)).inboxUnread).toBe(3);
    });

    it("a thread filed into a hidden category leaves the Inbox at once, and comes back when it leaves the category", async () => {
      const { store, linkedin, li, w, plain } = await setup();
      await store.categories.update(linkedin, { showInInbox: false });
      await store.categories.add({ categoryId: linkedin, threadIds: [w], addedBy: "user", now: NOW });
      expect(await ids(store, { view: "inbox", limit: 10 })).toEqual([plain]);
      expect((await store.threads.counts(NOW)).inboxUnread).toBe(0);
      await store.categories.remove({ categoryId: linkedin, threadIds: [w, li], reason: "user", now: NOW + 1 });
      expect(await ids(store, { view: "inbox", limit: 10 })).toEqual([plain, w, li]);
    });

    it("Waiting's page, scope and count leave them out too", async () => {
      const store = await fresh();
      const [a] = await withAccounts(store, 1);
      const linkedin = (await store.categories.create("LinkedIn", "cyan")).id;
      const me = { to: [addr("me0@example.com", "Me")] };
      await ingest(store, [
        msg({ accountId: a!, providerMsgId: "recruiter", rfcMessageId: "r@x", from: addr("maria@recruit.com", "María"), ...me, date: NOW - DAY }),
        msg({ accountId: a!, providerMsgId: "carlos", rfcMessageId: "c@x", from: addr("carlos@acme.com", "Carlos"), ...me, date: NOW - 2 * DAY }),
      ]);
      const recruiter = await threadOf(store, "recruiter");
      const carlos = await threadOf(store, "carlos");
      expect((await store.threads.counts(NOW)).inboxWaiting).toBe(2);
      await store.categories.add({ categoryId: linkedin, threadIds: [recruiter], addedBy: "user", now: NOW });
      await store.categories.update(linkedin, { showInInbox: false });
      expect(await ids(store, { view: "inbox", filter: "waiting", now: NOW, limit: 10 })).toEqual([carlos]);
      expect(await store.threads.scopeIds({ view: "inbox", filter: "waiting", now: NOW, limit: 10 })).toEqual([carlos]);
      expect(await store.threads.scopeCount({ view: "inbox", filter: "waiting", now: NOW, limit: 10 })).toBe(1);
      const counts = await store.threads.counts(NOW);
      expect(counts.inboxWaiting).toBe(1);
      expect(counts.inboxWaitingByAccount?.[a!]).toBe(1);
    });

    it("arrivals in a hidden category don't read as Inbox mail (no notification)", async () => {
      const { store, linkedin } = await setup();
      await store.categories.update(linkedin, { showInInbox: false });
      const r = await ingest(store, [
        msg({ accountId: (await store.accounts.list())[0]!.id, providerMsgId: "li-new", inReplyTo: null, from: addr("jobs@linkedin.com"), date: NOW - 60_000 }),
        msg({ accountId: (await store.accounts.list())[0]!.id, providerMsgId: "other-new", from: addr("carlos@acme.com"), date: NOW - 30_000 }),
      ]);
      const liThread = await threadOf(store, "li-new");
      await store.categories.add({ categoryId: linkedin, threadIds: [liThread], addedBy: "filter", now: NOW });
      const rows = await store.sync.arrivals(r.inserted);
      expect(rows.map((x) => [x.fromEmail, x.inInbox]).sort()).toEqual([["carlos@acme.com", true], ["jobs@linkedin.com", false]]);
    });
  });
}
