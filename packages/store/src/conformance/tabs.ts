import { describe, expect, it } from "vitest";
import type { MailStore } from "../mail-store";
import { backfillFacts, ingest, msg, outlookAccount, threadOf, withAccounts } from "./fixtures";

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
      // plan 106: an account's Mark all as read is its Inbox's unread scope: exactly what its count counts
      expect(await store.threads.scopeIds({ view: "inbox", accountId: gmail, filter: "unread", limit: 10 })).toEqual([person, mixed].sort((x, y) => x - y));
      expect(await store.threads.scopeIds({ view: "inbox", accountId: imap, filter: "unread", limit: 10 })).toEqual([bulk]);
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
      // plan 106: with its tabs in the Inbox, its Mark all as read takes them too, as its count does
      expect(await s.threads.scopeIds({ view: "inbox", accountId: gmail, filter: "unread", limit: 10 })).toEqual([promo, social, person, mixed].sort((x, y) => x - y));
      expect((await s.threads.counts(NOW)).inboxUnreadByAccount[gmail]).toBe(4);
      const store = await reopen(s);
      expect(await ids(store, { view: "inbox", accountId: gmail, limit: 10 })).toEqual([mixed, person, social, promo]);
      await store.accounts.update(gmail, { separateTabs: true });
      expect((await store.accounts.get(gmail))!.separateTabs).toBe(true);
      expect(await ids(store, { view: "inbox", limit: 10 })).toEqual([bulk, mixed, person]);
    });

    it("a promotion from an address that becomes yours (an alias you send from) goes back to the Inbox once the facts know it", async () => {
      const { store, gmail } = await setup();
      await backfillFacts(store);
      await ingest(store, [msg({ accountId: gmail, providerMsgId: "alias-promo", from: addr("me.alias@example.com"), gmailLabels: PROMO, date: NOW })]);
      const thread = await threadOf(store, "alias-promo");
      expect(await ids(store, { view: "inbox", accountId: gmail, tab: "promotions", limit: 10 })).toContain(thread);
      // you send from it: it's yours, and mail of yours never decides a tab
      await ingest(store, [msg({ accountId: gmail, providerMsgId: "alias-sent", from: addr("me.alias@example.com"), to: [addr("bo@friends.com")], isSent: true, inInbox: false, gmailLabels: ["SENT"], date: NOW + 1 })]);
      await backfillFacts(store);
      // the tabs' pass the change asked for (the backend's runner drives it, a slice at a time)
      expect(await store.tabs.idle()).toBe(false);
      while ((await store.tabs.backfill({ limit: 50 })).more);
      expect(await ids(store, { view: "inbox", accountId: gmail, tab: "promotions", limit: 10 })).not.toContain(thread);
      expect(await ids(store, { view: "inbox", accountId: gmail, limit: 10 })).toContain(thread);
    });

    it("a conversation of only your own mail in the Inbox says so: no tab can take it (plan 256)", async () => {
      const { store, gmail, promo, person } = await setup();
      const row = async (thread: number) => (await store.threads.summaries([thread]))[0]!;
      // a note to yourself: sent, and received in the Inbox (Gmail gives it SENT and INBOX), no category of its own
      await ingest(store, [msg({ accountId: gmail, providerMsgId: "note", from: addr("me0@example.com"), to: [addr("me0@example.com")], isSent: true, gmailLabels: ["SENT", "INBOX"], date: NOW, rfcMessageId: "note@test" })]);
      const note = await threadOf(store, "note");
      expect(await row(note)).toMatchObject({ inInbox: true, onlyYours: true });
      expect((await store.threads.list({ view: "inbox", accountId: gmail, limit: 10 })).items.find((t) => t.id === note)).toMatchObject({ onlyYours: true });
      // the move offered nowhere would change nothing: your mail never decides a tab
      expect((await store.threads.act({ threadIds: [note], action: "toPromotions", signal: null, now: NOW + 1 })).threadIds).toEqual([]);
      // archived, it's out of the Inbox: the fact is the Inbox's, as the tab is
      await store.threads.act({ threadIds: [note], action: "archive", signal: null, now: NOW + 2 });
      expect((await row(note)).onlyYours).toBeUndefined();
      await store.threads.act({ threadIds: [note], action: "moveToInbox", signal: null, now: NOW + 3 });
      expect((await row(note)).onlyYours).toBe(true);
      // someone else answers in it: it's theirs too now
      await ingest(store, [msg({ accountId: gmail, providerMsgId: "note-reply", from: addr("ana@friends.com"), gmailLabels: PRIMARY, date: NOW + 4, inReplyTo: "note@test", references: ["note@test"], subject: "Re: Subject" })]);
      expect(await threadOf(store, "note-reply")).toBe(note);
      expect((await row(note)).onlyYours).toBeUndefined();
      // a thread in a tab, or in Primary from someone else, never is
      expect((await store.threads.summaries([promo, person])).every((t) => t.onlyYours === undefined)).toBe(true);
    });

    it("mail from an address that becomes yours makes its conversation only yours once the tabs' pass reaches it (plan 256)", async () => {
      const { store, gmail } = await setup();
      await backfillFacts(store);
      await ingest(store, [msg({ accountId: gmail, providerMsgId: "alias-note", from: addr("me.alias@example.com"), gmailLabels: PRIMARY, date: NOW })]);
      const thread = await threadOf(store, "alias-note");
      expect((await store.threads.summaries([thread]))[0]!.onlyYours).toBeUndefined();
      await ingest(store, [msg({ accountId: gmail, providerMsgId: "alias-sent2", from: addr("me.alias@example.com"), to: [addr("bo@friends.com")], isSent: true, inInbox: false, gmailLabels: ["SENT"], date: NOW + 1 })]);
      await backfillFacts(store);
      while ((await store.tabs.backfill({ limit: 50 })).more);
      expect((await store.threads.summaries([thread]))[0]!.onlyYours).toBe(true);
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

    it("Move to Inbox on an archived promotion lands it in the Inbox (not back in its tab); one undo puts back its place and its category", async () => {
      const { store, gmail, promo, bulk } = await setup();
      await store.threads.act({ threadIds: [promo, bulk], action: "archive", signal: null, now: NOW });
      const moved = await store.threads.act({ threadIds: [promo, bulk], action: "moveToInbox", signal: null, now: NOW + 1 });
      expect(new Set(moved.threadIds)).toEqual(new Set([promo, bulk]));
      expect(await ids(store, { view: "inbox", accountId: gmail, limit: 10 })).toContain(promo);
      expect(await ids(store, { view: "inbox", accountId: gmail, tab: "promotions", limit: 10 })).toEqual([]);
      expect((await store.ops.claimReady(NOW + 2, 10)).map((o) => o.kind)).toContain("toPrimary");
      await store.threads.restore({ messages: moved.before, now: NOW + 3 });
      expect(await ids(store, { view: "inbox", limit: 10 })).not.toContain(promo);
      expect(await ids(store, { view: "archive", limit: 10 })).toEqual(expect.arrayContaining([promo, bulk]));
      // its category came back too: Gmail's own Move to Inbox would land it in Promotions now
      const id = (await store.threads.get(promo))!.messages[0]!.id;
      expect(moved.before.find((m) => m.id === id)).toMatchObject({ inInbox: false, category: 2 });
    });

    it("Move to Inbox on a thread in a tab takes it out; with the account's tabs in the Inbox it leaves the category alone", async () => {
      const { store, gmail, promo, social } = await setup();
      const r = await store.threads.act({ threadIds: [promo], action: "moveToInbox", signal: null, now: NOW });
      expect(r.threadIds).toEqual([promo]);
      expect(await ids(store, { view: "inbox", accountId: gmail, tab: "promotions", limit: 10 })).toEqual([]);
      await store.accounts.update(gmail, { separateTabs: false });
      const s = await store.threads.act({ threadIds: [social], action: "moveToInbox", signal: null, now: NOW + 1 });
      expect(s.threadIds).toEqual([]);
      await store.accounts.update(gmail, { separateTabs: true });
      expect(await ids(store, { view: "inbox", accountId: gmail, tab: "social", limit: 10 })).toEqual([social]);
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

  describe("Outlook's Focused Inbox, Other out of the Inbox (plan 275)", () => {
    const FOCUSED = 1, OTHER = 6;
    async function setup() {
      const store = await fresh();
      const [gmail] = await withAccounts(store, 1);
      const outlook = await outlookAccount(store);
      const thread = async (pid: string, over: Partial<Parameters<typeof msg>[0]> = {}) => {
        await ingest(store, [msg({ accountId: outlook, providerMsgId: pid, date: NOW - DAY, folder: null, ...over })]);
        return threadOf(store, pid);
      };
      const news = await thread("news", { from: addr("news@shop.com"), category: OTHER, date: NOW - 5 * DAY });
      const person = await thread("person", { from: addr("ana@friends.com"), category: FOCUSED, date: NOW - 4 * DAY });
      // one Focused message keeps the conversation in the Inbox
      const mixed = await thread("mixed-1", { from: addr("news@shop.com"), category: OTHER, date: NOW - 3 * DAY, rfcMessageId: "mixed@o" });
      await ingest(store, [msg({ accountId: outlook, providerMsgId: "mixed-2", from: addr("ana@friends.com"), category: FOCUSED, date: NOW - 3 * DAY + 1, inReplyTo: "mixed@o", references: ["mixed@o"], subject: "Re: Subject", folder: null })]);
      await ingest(store, [msg({ accountId: gmail!, providerMsgId: "promo", from: addr("deals@shop.com"), gmailLabels: PROMO, date: NOW - 2 * DAY })]);
      const promo = await threadOf(store, "promo");
      return { store, gmail: gmail!, outlook, news, person, mixed, promo };
    }
    const ids = async (store: MailStore, p: Parameters<MailStore["threads"]["list"]>[0]) => (await store.threads.list(p)).items.map((t) => t.id);
    const messageOf = async (store: MailStore, thread: number) => (await store.threads.get(thread))!.messages[0]!.id;

    it("a conversation that's all Other leaves the unified and the account's Inbox, lives in Other, counts there, and isn't news", async () => {
      const { store, outlook, news, person, mixed } = await setup();
      expect(await ids(store, { view: "inbox", accountId: outlook, limit: 10 })).toEqual([mixed, person]);
      expect(await ids(store, { view: "inbox", limit: 10 })).not.toContain(news);
      expect(await ids(store, { view: "inbox", accountId: outlook, tab: "other", limit: 10 })).toEqual([news]);
      expect((await store.threads.list({ view: "inbox", accountId: outlook, tab: "other", limit: 10 })).items[0]).toMatchObject({ id: news, tab: 3 });
      expect(await store.threads.scopeIds({ view: "inbox", accountId: outlook, tab: "other", limit: 10 })).toEqual([news]);
      expect(await store.threads.scopeCount({ view: "inbox", accountId: outlook, tab: "other", limit: 10 })).toBe(1);
      const counts = await store.threads.counts(NOW);
      expect(counts.tabUnread?.[`${outlook}:other`]).toBe(1);
      expect(counts.inboxUnreadByAccount[outlook]).toBe(2);
      const r = await ingest(store, [msg({ accountId: outlook, providerMsgId: "new-other", from: addr("deals@else.com"), category: OTHER, date: NOW, folder: null })]);
      expect((await store.sync.arrivals(r.inserted)).map((a) => a.inInbox)).toEqual([false]);
    });

    it("each account follows its own setting: Outlook's off shows its Other whatever Gmail's is, and the reverse", async () => {
      const { store, gmail, outlook, news, promo } = await setup();
      await store.accounts.update(outlook, { separateTabs: false });
      expect(await ids(store, { view: "inbox", limit: 10 })).toContain(news);
      expect(await ids(store, { view: "inbox", limit: 10 })).not.toContain(promo);
      expect((await store.threads.counts(NOW)).inboxUnreadByAccount[outlook]).toBe(3);
      await store.accounts.update(outlook, { separateTabs: true });
      await store.accounts.update(gmail, { separateTabs: false });
      expect(await ids(store, { view: "inbox", limit: 10 })).not.toContain(news);
      expect(await ids(store, { view: "inbox", limit: 10 })).toContain(promo);
    });

    it("Outlook's classification as a flag update re-tabs it; Move to Other and Move to Inbox are Outlook's only, and each undo puts back the category alone", async () => {
      const { store, gmail, outlook, news, person, promo } = await setup();
      await store.sync.updateFlags(outlook, [{ messageId: await messageOf(store, person), flags: {}, category: OTHER }]);
      expect(await ids(store, { view: "inbox", accountId: outlook, tab: "other", limit: 10 })).toEqual([person, news]);
      await store.sync.updateFlags(outlook, [{ messageId: await messageOf(store, person), flags: {}, category: FOCUSED }]);
      // Move to Other: the Outlook conversation only (a Gmail one has no Other), and its undo leaves a later read alone
      const moved = await store.threads.act({ threadIds: [person, promo], action: "toOther", signal: null, now: NOW });
      expect(moved.threadIds).toEqual([person]);
      expect(moved.before).toEqual([expect.objectContaining({ category: FOCUSED, only: "category" })]);
      expect((await store.ops.claimReady(NOW + 1, 10)).map((o) => [o.kind, o.account_id])).toEqual([["toOther", outlook]]);
      await store.threads.act({ threadIds: [person], action: "markRead", signal: null, now: NOW + 2 });
      await store.threads.restore({ messages: moved.before, now: NOW + 3 });
      expect(await ids(store, { view: "inbox", accountId: outlook, limit: 10 })).toContain(person);
      expect((await store.threads.summaries([person]))[0]!.unread).toBe(false);
      // Move to Promotions never reaches an Outlook conversation
      const wrong = await store.threads.act({ threadIds: [news], action: "toPromotions", signal: null, now: NOW + 4 });
      expect(wrong.threadIds).toEqual([]);
      // Move to Inbox out of Other: one action, one undo back to Other
      const back = await store.threads.act({ threadIds: [news], action: "moveToInbox", signal: null, now: NOW + 5 });
      expect(back.threadIds).toEqual([news]);
      expect(await ids(store, { view: "inbox", accountId: outlook, tab: "other", limit: 10 })).toEqual([]);
      expect((await store.ops.claimReady(NOW + 6, 10)).map((o) => o.kind)).toContain("toPrimary");
      await store.threads.restore({ messages: back.before, now: NOW + 7 });
      expect(await ids(store, { view: "inbox", accountId: outlook, tab: "other", limit: 10 })).toEqual([news]);
      void gmail;
    });

    it("counts with a category hidden from the Inbox (SQLite's other count branch) leave Other out the same way", async () => {
      const { store, outlook } = await setup();
      const hidden = (await store.categories.create("Hidden", "slate")).id;
      await store.categories.update(hidden, { showInInbox: false });
      const counts = await store.threads.counts(NOW);
      expect(counts.tabUnread?.[`${outlook}:other`]).toBe(1);
      expect(counts.inboxUnreadByAccount[outlook]).toBe(2);
      await store.accounts.update(outlook, { separateTabs: false });
      expect((await store.threads.counts(NOW)).inboxUnreadByAccount[outlook]).toBe(3);
    });

    it("a read begun before Move to Inbox landed and committed after it never takes it back; one begun after is taken", async () => {
      const { store, outlook, news } = await setup();
      const before = await store.sync.beginObservation?.(outlook, { authoritativeFlags: true });
      if (!before) return;
      await store.threads.act({ threadIds: [news], action: "toPrimary", signal: null, now: NOW });
      for (const op of await store.ops.claimReady(NOW + 1, 10)) await store.ops.complete(op.id, undefined, NOW + 2);
      const id = await messageOf(store, news);
      await store.sync.updateFlags(outlook, [{ messageId: id, expectedProviderMsgId: "news", flags: {}, category: OTHER }], before);
      expect(await ids(store, { view: "inbox", accountId: outlook, tab: "other", limit: 10 })).toEqual([]);
      const after = (await store.sync.beginObservation?.(outlook, { authoritativeFlags: true }))!;
      await store.sync.updateFlags(outlook, [{ messageId: id, expectedProviderMsgId: "news", flags: {}, category: OTHER }], after);
      expect(await ids(store, { view: "inbox", accountId: outlook, tab: "other", limit: 10 })).toEqual([news]);
    });

    it("code review #3, #6: a newer category move takes the older one's place while it waits, the newest rule for a sender the older's; a read again without a classification keeps the stored one", async () => {
      const { store, outlook, person, news } = await setup();
      await store.threads.act({ threadIds: [person], action: "toOther", signal: null, now: NOW });
      await store.threads.act({ threadIds: [person], action: "toPrimary", signal: null, now: NOW + 1 });
      expect((await store.ops.claimReady(NOW + 2, 10)).map((o) => o.kind)).toEqual(["toPrimary"]);
      await store.ops.enqueueAccount({ accountId: outlook, kind: "classifySender", payload: { address: "news@shop.com", as: "other" }, now: NOW });
      await store.ops.enqueueAccount({ accountId: outlook, kind: "unclassifySender", payload: { address: "news@shop.com", as: "other", prior: null }, now: NOW + 1 });
      await store.ops.enqueueAccount({ accountId: outlook, kind: "classifySender", payload: { address: "ana@friends.com", as: "focused" }, now: NOW + 2 });
      expect((await store.ops.claimReady(NOW + 3, 10)).map((o) => o.kind)).toEqual(["unclassifySender", "classifySender"]);
      // the message read whole again (its attachments), Graph saying nothing of its classification: still Other
      await ingest(store, [msg({ accountId: outlook, providerMsgId: "news", from: addr("news@shop.com"), defaultCategory: FOCUSED, date: NOW - 5 * DAY, folder: null })]);
      expect(await ids(store, { view: "inbox", accountId: outlook, tab: "other", limit: 10 })).toEqual([news]);
    });

    it("the sender override is an op of the account's, naming no messages; no other kind is queued that way", async () => {
      const { store, outlook } = await setup();
      const id = await store.ops.enqueueAccount({ accountId: outlook, kind: "classifySender", payload: { address: "news@shop.com", as: "other" }, now: NOW });
      const [op] = await store.ops.claimReady(NOW + 1, 10);
      expect(op).toMatchObject({ id, kind: "classifySender", account_id: outlook });
      expect(JSON.parse(op!.payload_json)).toEqual({ address: "news@shop.com", as: "other" });
      expect(JSON.parse(op!.target_json)).toEqual({ messageIds: [] });
      await expect(store.ops.enqueueAccount({ accountId: outlook, kind: "archive", payload: {}, now: NOW })).rejects.toThrow();
    });

    it("a stale classification never takes back a move still on its way; a fresh one after it lands is taken", async () => {
      const { store, outlook, news } = await setup();
      await store.threads.act({ threadIds: [news], action: "toPrimary", signal: null, now: NOW });
      const id = await messageOf(store, news);
      // what a delta read before the move, committed after it
      await store.sync.updateFlags(outlook, [{ messageId: id, flags: {}, category: OTHER }]);
      expect(await ids(store, { view: "inbox", accountId: outlook, tab: "other", limit: 10 })).toEqual([]);
      for (const op of await store.ops.claimReady(NOW + 1, 10)) await store.ops.complete(op.id, undefined, NOW + 2);
      // a read begun after it landed
      const observation = await store.sync.beginObservation?.(outlook, { authoritativeFlags: true });
      if (!observation) return;
      await store.sync.updateFlags(outlook, [{ messageId: id, expectedProviderMsgId: "news", flags: {}, category: OTHER }], observation);
      expect(await ids(store, { view: "inbox", accountId: outlook, tab: "other", limit: 10 })).toEqual([news]);
    });
  });
}