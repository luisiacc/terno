import { describe, expect, it } from "vitest";
import type { MailStore } from "../mail-store";
import { ingest, msg, threadOf, withAccounts } from "./fixtures";

const NOW = Date.UTC(2026, 9, 31, 12);
const DAY = 86_400_000;
const addr = (email: string, name = "") => ({ name, email });
const PROMO = ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"];
const SOCIAL = ["INBOX", "UNREAD", "CATEGORY_SOCIAL"];
const PRIMARY = ["INBOX", "UNREAD", "CATEGORY_PERSONAL"];

/**
 * Plan 86: Gmail's Promotions and Social tabs. A Gmail thread whose every
 * Inbox message of someone else's is in a tab leaves the plain Inbox (unified
 * and the account's: pages, filters, kept rows, scopes, counts, notifications)
 * and lives in the tab's own list; the account's setting turns it off at once.
 * Moving to the Inbox is a category op Gmail learns from, undone exactly, and
 * a stale observation never takes it back while it's pending.
 */
export function defineTabsConformance(fresh: () => Promise<MailStore>, reopen: (store: MailStore) => Promise<MailStore>): void {
  describe("Gmail tabs out of the Inbox (plan 86)", () => {
    async function setup() {
      const store = await fresh();
      const [gmail, imap] = await withAccounts(store, 2);
      const thread = async (pid: string, over: Partial<Parameters<typeof msg>[0]> = {}) => {
        await ingest(store, [msg({ accountId: gmail!, providerMsgId: pid, date: NOW - DAY, ...over })]);
        return threadOf(store, pid);
      };
      const promo = await thread("promo", { from: addr("deals@shop.com"), gmailLabels: PROMO, date: NOW - 5 * DAY });
      const social = await thread("social", { from: addr("notify@social.com"), gmailLabels: SOCIAL, date: NOW - 4 * DAY });
      const person = await thread("person", { from: addr("ana@friends.com"), gmailLabels: PRIMARY, date: NOW - 3 * DAY });
      // a person replied in a promotion's thread: Primary wins, the conversation stays in the Inbox
      const mixed = await thread("mixed-1", { from: addr("news@shop.com"), gmailLabels: PROMO, date: NOW - 2 * DAY, rfcMessageId: "mixed@test" });
      await ingest(store, [msg({ accountId: gmail!, providerMsgId: "mixed-2", from: addr("ana@friends.com"), gmailLabels: PRIMARY, date: NOW - 2 * DAY + 1, inReplyTo: "mixed@test", references: ["mixed@test"], subject: "Re: Subject" })]);
      const bulk = await thread("bulk", { accountId: imap!, from: addr("deals@shop.com"), date: NOW - DAY });
      return { store, gmail: gmail!, imap: imap!, promo, social, person, mixed, bulk };
    }
    const ids = async (store: MailStore, p: Parameters<MailStore["threads"]["list"]>[0]) => (await store.threads.list(p)).items.map((t) => t.id);

    it("a thread in Promotions or Social leaves the unified and the account's Inbox and lives in its tab", async () => {
      const { store, gmail, imap, promo, social, person, mixed, bulk } = await setup();
      expect(await threadOf(store, "mixed-2")).toBe(mixed);
      expect(await ids(store, { view: "inbox", limit: 10 })).toEqual([bulk, mixed, person]);
      expect(await ids(store, { view: "inbox", accountId: gmail, limit: 10 })).toEqual([mixed, person]);
      expect(await ids(store, { view: "inbox", accountId: imap, limit: 10 })).toEqual([bulk]);
      expect(await ids(store, { view: "inbox", accountId: gmail, tab: "promotions", limit: 10 })).toEqual([promo]);
      expect(await ids(store, { view: "inbox", accountId: gmail, tab: "social", limit: 10 })).toEqual([social]);
      expect(await ids(store, { view: "inbox", accountId: imap, tab: "promotions", limit: 10 })).toEqual([]);
      expect((await store.threads.list({ view: "inbox", accountId: gmail, tab: "promotions", limit: 10 })).items[0]).toMatchObject({ id: promo, tab: 1 });
      // the rest of the mailbox keeps them
      expect(await ids(store, { view: "all", limit: 10 })).toEqual(expect.arrayContaining([promo, social]));
    });

    it("filters, kept rows, scopes and counts follow the Inbox; a tab has its own", async () => {
      const { store, gmail, imap, promo, social, person, mixed, bulk } = await setup();
      expect(await ids(store, { view: "inbox", filter: "unread", limit: 10 })).toEqual([bulk, mixed, person]);
      expect(await ids(store, { view: "inbox", filter: "unread", keepIds: [promo], limit: 10 })).toEqual([bulk, mixed, person]);
      expect(await store.threads.scopeIds({ view: "inbox", limit: 10 })).toEqual([person, mixed, bulk].sort((x, y) => x - y));
      expect(await store.threads.scopeCount({ view: "inbox", limit: 10 })).toBe(3);
      expect(await store.threads.scopeIds({ view: "inbox", accountId: gmail, tab: "promotions", limit: 10 })).toEqual([promo]);
      expect(await store.threads.scopeCount({ view: "inbox", accountId: gmail, tab: "social", limit: 10 })).toBe(1);
      expect(await ids(store, { view: "inbox", accountId: gmail, tab: "promotions", filter: "unread", limit: 10 })).toEqual([promo]);
      const counts = await store.threads.counts(NOW);
      expect(counts.inboxUnread).toBe(3);
      expect(counts.inboxUnreadByAccount[gmail]).toBe(2);
      expect(counts.inboxUnreadByAccount[imap]).toBe(1);
      expect(counts.tabUnread).toEqual({ [`${gmail}:promotions`]: 1, [`${gmail}:social`]: 1 });
      await store.threads.act({ threadIds: [social], action: "markRead", signal: null, now: NOW });
      expect((await store.threads.counts(NOW)).tabUnread).toEqual({ [`${gmail}:promotions`]: 1 });
    });

    it("a tab's pages walk past the cursor in date order", async () => {
      const { store, gmail, promo } = await setup();
      for (let i = 0; i < 3; i++) await ingest(store, [msg({ accountId: gmail, providerMsgId: `p${i}`, from: addr(`deals${i}@shop.com`), gmailLabels: PROMO, date: NOW - 10 * DAY + i })]);
      const older = await Promise.all([2, 1, 0].map((i) => threadOf(store, `p${i}`)));
      const first = await store.threads.list({ view: "inbox", accountId: gmail, tab: "promotions", limit: 2 });
      expect(first.items.map((t) => t.id)).toEqual([promo, older[0]]);
      expect(await ids(store, { view: "inbox", accountId: gmail, tab: "promotions", limit: 10, cursor: first.nextCursor! })).toEqual([older[1], older[2]]);
    });

    it("your own mail never decides; Updates and Forums stay in the Inbox", async () => {
      const { store, gmail, promo } = await setup();
      await ingest(store, [msg({ accountId: gmail, providerMsgId: "mine", from: addr("me0@example.com"), isSent: true, gmailLabels: ["SENT"], date: NOW, inReplyTo: "m-promo", references: [] })]);
      // a reply of yours in the promotion's thread (by its Gmail thread): still a promotion
      await ingest(store, [msg({ accountId: gmail, providerMsgId: "reply", providerThreadId: null, from: addr("me0@example.com"), isSent: true, gmailLabels: ["SENT"], date: NOW, rfcMessageId: "r@test", inReplyTo: (await store.threads.get(promo))!.messages[0]!.rfcMessageId, references: [] })]);
      expect(await threadOf(store, "reply")).toBe(promo);
      expect(await ids(store, { view: "inbox", accountId: gmail, tab: "promotions", limit: 10 })).toEqual([promo]);
      await ingest(store, [msg({ accountId: gmail, providerMsgId: "upd", from: addr("bank@bank.com"), gmailLabels: ["INBOX", "CATEGORY_UPDATES"], date: NOW })]);
      await ingest(store, [msg({ accountId: gmail, providerMsgId: "forum", from: addr("list@groups.com"), gmailLabels: ["INBOX", "CATEGORY_FORUMS"], date: NOW })]);
      const inbox = await ids(store, { view: "inbox", accountId: gmail, limit: 10 });
      expect(inbox).toEqual(expect.arrayContaining([await threadOf(store, "upd"), await threadOf(store, "forum")]));
    });

    it("turning the setting off brings them back at once, everywhere, and on takes them out again (survives a reopen)", async () => {
      const { store: s, gmail, promo, social, person, mixed, bulk } = await setup();
      await s.accounts.update(gmail, { separateTabs: false });
      expect((await s.accounts.get(gmail))!.separateTabs).toBe(false);
      expect(await ids(s, { view: "inbox", limit: 10 })).toEqual([bulk, mixed, person, social, promo]);
      expect((await s.threads.counts(NOW)).inboxUnread).toBe(5);
      const store = await reopen(s);
      expect(await ids(store, { view: "inbox", accountId: gmail, limit: 10 })).toEqual([mixed, person, social, promo]);
      await store.accounts.update(gmail, { separateTabs: true });
      expect((await store.accounts.get(gmail))!.separateTabs).toBe(true);
      expect(await ids(store, { view: "inbox", limit: 10 })).toEqual([bulk, mixed, person]);
    });

    it("a new arrival in a tab isn't Inbox mail to notify about", async () => {
      const { store, gmail } = await setup();
      const r = await ingest(store, [msg({ accountId: gmail, providerMsgId: "new-promo", from: addr("sale@shop.com"), gmailLabels: PROMO, date: NOW }), msg({ accountId: gmail, providerMsgId: "new-person", from: addr("bo@friends.com"), gmailLabels: PRIMARY, date: NOW })]);
      const rows = await store.sync.arrivals(r.inserted);
      expect(rows.map((a) => a.inInbox)).toEqual([false, true]);
      await store.accounts.update(gmail, { separateTabs: false });
      expect((await store.sync.arrivals(r.inserted)).map((a) => a.inInbox)).toEqual([true, true]);
    });

    it("Move to Inbox sets the category on Gmail's messages only, and its undo puts each one back exactly", async () => {
      const { store, gmail, imap, promo, bulk } = await setup();
      const before = await store.threads.act({ threadIds: [promo, bulk], action: "toPrimary", signal: null, now: NOW });
      expect(before.threadIds).toEqual([promo]);
      expect(before.before).toEqual([expect.objectContaining({ category: 2 })]);
      expect(await ids(store, { view: "inbox", accountId: gmail, tab: "promotions", limit: 10 })).toEqual([]);
      expect(await ids(store, { view: "inbox", accountId: gmail, limit: 10 })).toContain(promo);
      const ops = await store.ops.claimReady(NOW + 1, 10);
      expect(ops.map((o) => [o.kind, o.account_id])).toEqual([["toPrimary", gmail]]);
      expect(ops.some((o) => o.account_id === imap)).toBe(false);
      const undone = await store.threads.restore({ messages: before.before, now: NOW + 2 });
      expect(undone.threadIds).toEqual([promo]);
      expect(await ids(store, { view: "inbox", accountId: gmail, tab: "promotions", limit: 10 })).toEqual([promo]);
      const back = await store.ops.claimReady(NOW + 3, 10);
      expect(back.map((o) => o.kind)).toEqual(["toPromotions"]);
    });

    it("an archive's undo never touches the category Gmail changed meanwhile", async () => {
      const { store, gmail, promo } = await setup();
      const archived = await store.threads.act({ threadIds: [promo], action: "archive", signal: null, now: NOW });
      expect(archived.before.every((m) => m.category === undefined)).toBe(true);
      const id = (await store.threads.get(promo))!.messages[0]!.id;
      await store.sync.updateFlags(gmail, [{ messageId: id, flags: {}, gmailLabels: ["CATEGORY_PERSONAL"] }]);
      await store.threads.restore({ messages: archived.before, now: NOW + 1 });
      expect(await ids(store, { view: "inbox", accountId: gmail, limit: 10 })).toContain(promo);
      expect(await ids(store, { view: "inbox", accountId: gmail, tab: "promotions", limit: 10 })).toEqual([]);
    });

    it("Gmail's later moves are seen; a stale one never takes back a move still on its way", async () => {
      const { store, gmail, promo, person } = await setup();
      const personMsg = (await store.threads.get(person))!.messages[0]!.id;
      await store.sync.updateFlags(gmail, [{ messageId: personMsg, flags: {}, gmailLabels: SOCIAL }]);
      expect(await ids(store, { view: "inbox", accountId: gmail, tab: "social", limit: 10 })).toContain(person);
      await store.threads.act({ threadIds: [promo], action: "toPrimary", signal: null, now: NOW });
      const promoMsg = (await store.threads.get(promo))!.messages[0]!.id;
      // what a refresh fetched before the move, committed after it
      await store.sync.updateFlags(gmail, [{ messageId: promoMsg, flags: {}, gmailLabels: PROMO }]);
      expect(await ids(store, { view: "inbox", accountId: gmail, tab: "promotions", limit: 10 })).toEqual([]);
      expect(await ids(store, { view: "inbox", accountId: gmail, limit: 10 })).toContain(promo);
    });
  });
}
