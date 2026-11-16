import { DATED_ACTIVE_MAX, DATED_CLOSED_KEEP_MS, datedGroupAt } from "@terno/core";
import { describe, expect, it } from "vitest";
import { DATED_MARK_MS, DATED_SCAN_MARK_MS, type DatedFinish, type DatedWrite } from "../dated";
import { AWAITING_ITEM, FOLLOWUPS_ACTIVE_MAX, type FollowupFinish, type FollowupWrite } from "../followups";
import type { MailStore } from "../mail-store";
import type { IncomingMessage } from "../types";
import { msg, threadOf, withAccounts } from "./fixtures";

const NOW = Date.UTC(2026, 10, 13, 12);
const DAY = 86_400_000;
const me = { name: "Me", email: "me0@example.com" };
const bank = { name: "Bank", email: "Bills@Bank.test" };
const shop = { name: "Shop", email: "orders@shop.test" };

/**
 * Plan 204: received mail is marked in the ingest that inserts it, by the new-mail rule and only when asked; a finish
 * writes, settles and consumes in one step that checks the clear generation and the source (revision 6); everything a
 * user does is conditional on the revision they saw.
 */
export function defineDatedConformance(fresh: () => Promise<MailStore>, reopen: (store: MailStore) => Promise<MailStore>): void {
  describe("Dated items (plan 204)", () => {
    async function setup() {
      const store = await fresh();
      const [accountId, other] = await withAccounts(store, 2);
      const got = async (over: Partial<IncomingMessage> = {}, datedMail: { since: number | null } | null = { since: null }, at = NOW) => {
        const m = msg({ accountId: accountId!, from: bank, to: [me], date: at - 60_000, ...over });
        const r = await store.sync.ingest([m], { applyFilters: false, now: at, classifier: null, ...(datedMail ? { datedMail } : {}) });
        return { id: r.inserted[0]!, thread: await threadOf(store, m.providerMsgId!), m };
      };
      const item = (over: Partial<DatedWrite> = {}): DatedWrite => ({ kind: "pay", item: 0, text: "Pay the electricity bill", quote: "due on November 20", dueDay: "2026-11-20", dueAt: NOW + 7 * DAY, timed: false, dated: true, actAt: NOW + 4 * DAY, ...over });
      const finish = (messageId: number, threadId: number, over: Partial<DatedFinish> = {}) =>
        store.dated.finish({ messageId, threadId, fromScan: false, rows: [], settled: [], now: NOW, model: "m", provider: "p", promptVersion: 1, clearGeneration: store.dated.clearGeneration(), ...over });
      const marked = async () => (await store.dated.marks.page(null, 100)).map((m) => m.messageId);
      return { store, accountId: accountId!, other: other!, got, item, finish, marked };
    }

    describe("the marker", () => {
      it("marks received live mail only when asked, by the same rule as new mail", async () => {
        const { store, accountId, got, marked } = await setup();
        const a = await got();
        await got({}, null);
        const variants: Partial<IncomingMessage>[] = [{}, { isSent: true, from: me, to: [bank], inInbox: false }, { isSpam: true }, { isTrash: true }, { isDraft: true }, { from: me }, { date: NOW - 4 * DAY }];
        const batch = variants.map((over) => msg({ accountId, from: bank, to: [me], date: NOW - 1000, ...over }));
        const r = await store.sync.ingest(batch, { applyFilters: false, now: NOW, classifier: null, datedMail: { since: null }, newMail: { summary: false, category: true } });
        const fresh = r.inserted[0]!;
        // one predicate: what new mail takes, this takes
        expect((await store.newMail.page("category", null, 100)).map((m) => m.messageId)).toEqual([fresh]);
        expect(await marked()).toEqual([a.id, fresh]);
        const [mark] = await store.dated.marks.page(null, 1);
        expect(mark).toEqual({ messageId: a.id, threadId: a.thread, arrivedAt: a.m.date, queuedAt: NOW, source: "live" });
        // re-ingesting the same message doesn't double it
        await store.sync.ingest([a.m], { applyFilters: false, now: NOW, classifier: null, datedMail: { since: null } });
        expect(await store.dated.marks.count()).toBe(2);
      });

      it("mail from before the feature went on isn't marked", async () => {
        const { got, marked } = await setup();
        await got({ date: NOW - 2 * DAY }, { since: NOW - DAY });
        const after = await got({ date: NOW - 1000 }, { since: NOW - DAY });
        expect(await marked()).toEqual([after.id]);
      });

      it("pages oldest first by the message's date, then its id", async () => {
        const { store, accountId } = await setup();
        const dates = [NOW - 3000, NOW - 9000, NOW - 3000, NOW - 1000];
        const r = await store.sync.ingest(dates.map((date) => msg({ accountId, from: bank, to: [me], date })), { applyFilters: false, now: NOW, classifier: null, datedMail: { since: null } });
        const want = r.inserted.map((id, i) => ({ id, date: dates[i]! })).sort((x, y) => x.date - y.date || x.id - y.id).map((x) => x.id);
        const first = await store.dated.marks.page(null, 2);
        const rest = await store.dated.marks.page({ arrivedAt: first[1]!.arrivedAt, messageId: first[1]!.messageId }, 10);
        expect([...first, ...rest].map((m) => m.messageId)).toEqual(want);
      });

      it("a check takes received mail not yet read, newest first, once; its marks keep 14 days and a live one 3", async () => {
        const { store, got, item, finish, marked } = await setup();
        const live = await got();
        const older = await got({ date: NOW - 10 * DAY }, null);
        const old = await got({ date: NOW - 5 * DAY }, null);
        await got({ date: NOW - 5 * DAY, isSent: true, from: me, to: [bank], inInbox: false }, null);
        await got({ date: NOW - 5 * DAY, isSpam: true }, null);
        await got({ date: NOW - 5 * DAY, from: me }, null);
        const read = await got({ date: NOW - 6 * DAY }, null);
        await store.dated.marks.queueScan([read.id], NOW);
        await finish(read.id, read.thread, { rows: [item()], fromScan: true });
        expect(await store.dated.scanCandidates(NOW - 14 * DAY, 10)).toEqual([old.id, older.id]);
        expect(await store.dated.scanCandidates(NOW - 14 * DAY, 1)).toEqual([old.id]);
        expect(await store.dated.marks.queueScan([old.id, older.id, read.id, live.id], NOW)).toBe(2);
        expect(await store.dated.marks.queueScan([old.id, older.id], NOW)).toBe(0);
        expect(await store.dated.scanCandidates(NOW - 14 * DAY, 10)).toEqual([]);
        expect((await store.dated.marks.page(null, 10)).map((m) => [m.messageId, m.source])).toEqual([[older.id, "scan"], [old.id, "scan"], [live.id, "live"]]);
        expect(await store.dated.marks.prune(NOW + DATED_MARK_MS + 1)).toBe(1);
        expect(await marked()).toEqual([older.id, old.id]);
        expect(await store.dated.marks.prune(NOW + DATED_SCAN_MARK_MS + 1)).toBe(2);
        expect(await store.dated.marks.count()).toBe(0);
      });

      it("a mark goes with its message, and survives a reopen", async () => {
        const { store, got } = await setup();
        const a = await got();
        await got();
        await store.sync.remove([a.id]);
        expect(await store.dated.marks.count()).toBe(1);
        const back = await reopen(store);
        expect(await back.dated.marks.count()).toBe(1);
      });

      it("the source says what the reader needs, without the body", async () => {
        const { store, got } = await setup();
        const promo = await got({ gmailLabels: ["INBOX", "CATEGORY_PROMOTIONS"], listId: "deals.bank.test", subject: "Your bill" });
        expect(await store.dated.source(promo.id)).toMatchObject({ id: promo.id, threadId: promo.thread, subject: "Your bill", fromName: "Bank", senderKey: "bills@bank.test", automated: true, tab: "promotions", draft: false, sent: false, spam: false, trash: false, threadSpam: false, own: false, bodyState: "full", bodyUnavailable: false });
        expect((await store.dated.source(promo.id))!.fromEmail.toLowerCase()).toBe("bills@bank.test");
        const plain = await got({ gmailLabels: null });
        expect(await store.dated.source(plain.id)).toMatchObject({ automated: false, tab: null });
        const mine = await got({ from: me }, null);
        expect((await store.dated.source(mine.id))!.own).toBe(true);
        expect(await store.dated.source(999_999)).toBeNull();
      });

      it("the third panel round: whether the sender is a person, by plan 17's rule (a role address once you've written to it)", async () => {
        const { store, accountId, got } = await setup();
        const ana = await got({ from: { name: "Ana Ruiz", email: "ana@studio.test" } });
        expect((await store.dated.source(ana.id))!.person).toBe(true);
        const list = await got({ from: { name: "Ana Ruiz", email: "ana@studio.test" }, listId: "news.studio.test" });
        expect((await store.dated.source(list.id))!.person).toBe(false);
        const noreply = await got({ from: { name: "Studio", email: "no-reply@studio.test" } });
        expect((await store.dated.source(noreply.id))!.person).toBe(false);
        const support = await got({ from: shop, subject: "Your question" });
        expect((await store.dated.source(support.id))!.person).toBe(false);
        await store.sync.ingest([msg({ accountId, from: me, to: [shop], isSent: true, inInbox: false, gmailLabels: ["SENT"], subject: "Re: Your question", date: NOW - 1000 })], { applyFilters: false, now: NOW, classifier: null });
        expect((await store.dated.source(support.id))!.person).toBe(true);
      });

      it("after the fourth panel round: written, the senders among some you've written to (plan 17's correspondents), by key", async () => {
        const { store, accountId } = await setup();
        const jane = { name: "Jane", email: "jane@acme-support.com" };
        expect(await store.dated.written(["jane@acme-support.com", "orders@shop.test"])).toEqual(new Set());
        await store.sync.ingest([msg({ accountId, from: me, to: [jane], isSent: true, inInbox: false, gmailLabels: ["SENT"], subject: "The invoice", date: NOW - 1000 })], { applyFilters: false, now: NOW, classifier: null });
        expect(await store.dated.written(["jane@acme-support.com", "orders@shop.test", "jane@acme-support.com"])).toEqual(new Set(["jane@acme-support.com"]));
        expect(await store.dated.written([])).toEqual(new Set());
      });
    });

    describe("finish", () => {
      it("writes the items and consumes the mark together; nothing found still consumes it", async () => {
        const { store, got, item, finish } = await setup();
        const a = await got();
        expect(await finish(a.id, a.thread, { rows: [item(), item({ item: 1, kind: "event", text: "Flight to Madrid", actAt: NOW + DAY })] })).toBe("written");
        expect(await store.dated.marks.count()).toBe(0);
        const active = await store.dated.active();
        expect(active.map((r) => r.item)).toEqual([1, 0]);
        expect(active[1]).toEqual({
          id: active[1]!.id, threadId: a.thread, messageId: a.id, item: 0, kind: "pay", text: "Pay the electricity bill", quote: "due on November 20", senderKey: "bills@bank.test", dueDay: "2026-11-20", dueAt: NOW + 7 * DAY, timed: false, dated: true, actAt: NOW + 4 * DAY,
          deferredUntil: null, arrivedAt: a.m.date, state: "open", closedReason: null, closedAt: null, fromScan: false, revision: 0, model: "m", provider: "p", createdAt: NOW, early: false, sameAs: null, detailOf: null, lapses: false,
        });
        // read once: a second answer finds no mark and changes nothing
        expect(await finish(a.id, a.thread, { rows: [item({ item: 2 })] })).toBe("gone");
        expect(await store.dated.active()).toHaveLength(2);
        const b = await got();
        expect(await finish(b.id, b.thread)).toBe("written");
        expect(await store.dated.marks.count()).toBe(0);
        expect((await store.dated.ofThread(a.thread)).map((r) => r.item)).toEqual([1, 0]);
        expect(await store.dated.ofThread(b.thread)).toEqual([]);
      });

      it("a clear empties both and refuses a write that started before it", async () => {
        const { store, got, item, finish } = await setup();
        const a = await got();
        const b = await got();
        await finish(a.id, a.thread, { rows: [item()] });
        const generation = store.dated.clearGeneration();
        await store.dated.clear();
        expect(store.dated.clearGeneration()).not.toBe(generation);
        expect(await store.dated.active()).toEqual([]);
        expect(await store.dated.marks.count()).toBe(0);
        expect(await store.dated.marks.queueScan([b.id], NOW)).toBe(1);
        expect(await finish(b.id, b.thread, { rows: [item()], clearGeneration: generation })).toBe("gone");
        expect(await store.dated.marks.count()).toBe(1);
        expect(await finish(b.id, b.thread, { rows: [item()] })).toBe("written");
        expect(await store.dated.active()).toHaveLength(1);
      });

      it("spam anywhere on the thread ends the read: nothing written, the mark dropped", async () => {
        const { store, accountId, got, item, finish } = await setup();
        const a = await got({ rfcMessageId: "s@x" });
        await store.sync.ingest([msg({ accountId, from: shop, to: [me], inReplyTo: "s@x", references: ["s@x"], subject: "Re", date: NOW - 500, isSpam: true })], { applyFilters: false, now: NOW, classifier: null });
        expect((await store.dated.source(a.id))!.threadSpam).toBe(true);
        expect(await finish(a.id, a.thread, { rows: [item()] })).toBe("gone");
        expect(await store.dated.marks.count()).toBe(0);
        expect(await store.dated.active()).toEqual([]);
      });

      it("a merge moves marks and items to the surviving thread; a read from before it is 'moved' and the mark stays", async () => {
        const { store, got, item, finish } = await setup();
        const a = await got({ subject: "One", providerMsgId: "ma", rfcMessageId: "ma@x", date: NOW - 9000 });
        const b = await got({ subject: "Two", providerMsgId: "mb", rfcMessageId: "mb@x", date: NOW - 8000 });
        const c = await got({ subject: "Three", providerMsgId: "mc", rfcMessageId: "mc@x", date: NOW - 7000 });
        await finish(a.id, a.thread, { rows: [item()] });
        await finish(b.id, b.thread, { rows: [item()] });
        const bridge = await got({ subject: "Re", providerMsgId: "md", rfcMessageId: "md@x", references: ["ma@x", "mb@x", "mc@x"], inReplyTo: "mc@x", date: NOW - 6000 }, null);
        const rows = await store.dated.active();
        expect(rows.every((r) => r.threadId === bridge.thread)).toBe(true);
        expect(rows.filter((r) => r.revision === 1)).toHaveLength([a, b].filter((x) => x.thread !== bridge.thread).length);
        // c's mark: on the survivor now; a finish that read it elsewhere is told so and leaves it for another read
        expect((await store.dated.marks.page(null, 10)).map((m) => [m.messageId, m.threadId])).toEqual([[c.id, bridge.thread]]);
        const stale = [a, b, c].map((x) => x.thread).find((t) => t !== bridge.thread)!;
        expect(await finish(c.id, stale, { rows: [item({ item: 1 })] })).toBe("moved");
        expect(await store.dated.marks.count()).toBe(1);
        expect(await finish(c.id, bridge.thread, { rows: [item({ item: 1 })] })).toBe("written");
        expect((await store.dated.ofThread(bridge.thread)).length).toBe(3);
      });

      it("settles only the row at the revision shown, and only from its thread or its sender", async () => {
        const { store, accountId, got, item, finish } = await setup();
        const bill = await got({ rfcMessageId: "b0@x", date: NOW - 9000 });
        await finish(bill.id, bill.thread, { rows: [item(), item({ item: 1, kind: "renew", text: "Renew the plan" })] });
        const byItem = async (i: number) => (await store.dated.active()).find((r) => r.item === i)!;
        const byPay = () => byItem(0);
        const byRenew = () => byItem(1);
        const pay = await byPay();
        const renew = await byRenew();
        // someone else, elsewhere: neither
        const stranger = await got({ from: shop, date: NOW - 8000 });
        await finish(stranger.id, stranger.thread, { settled: [{ id: pay.id, revision: pay.revision }] });
        expect((await byPay()).state).toBe("open");
        // the sender, elsewhere, at a revision it wasn't shown: no
        const stale = await got({ date: NOW - 7000 });
        await finish(stale.id, stale.thread, { settled: [{ id: pay.id, revision: pay.revision + 3 }] });
        expect((await byPay()).state).toBe("open");
        // the sender, elsewhere, at the revision shown: settled
        const paid = await got({ date: NOW - 6000 });
        await finish(paid.id, paid.thread, { settled: [{ id: pay.id, revision: pay.revision }] });
        expect(await store.dated.get(pay.id)).toMatchObject({ state: "settled", closedReason: "settled", closedAt: NOW, revision: pay.revision + 1 });
        // someone else, on its thread: settled
        const r = await store.sync.ingest([msg({ accountId, from: shop, to: [me], inReplyTo: "b0@x", references: ["b0@x"], subject: "Re", date: NOW - 5000 })], { applyFilters: false, now: NOW, classifier: null, datedMail: { since: null } });
        await finish(r.inserted[0]!, bill.thread, { settled: [{ id: renew.id, revision: renew.revision }] });
        expect((await store.dated.get(renew.id))!.state).toBe("settled");
        expect(await store.dated.active()).toEqual([]);
      });

      it("past the bound, the furthest act-at isn't added: a sooner item takes its place, a later one doesn't come in", async () => {
        const { store, accountId, got, item, finish } = await setup();
        const a = await got();
        await finish(a.id, a.thread, { rows: Array.from({ length: DATED_ACTIVE_MAX }, (_, i) => item({ item: 10 + i, actAt: NOW + (i + 1) * 1000 })) });
        expect(await store.dated.active()).toHaveLength(DATED_ACTIVE_MAX);
        const b = await got();
        await finish(b.id, b.thread, { rows: [item({ item: 0, actAt: NOW + 10_000 * 1000 }), item({ item: 1, actAt: NOW })] });
        const active = await store.dated.active();
        expect(active).toHaveLength(DATED_ACTIVE_MAX);
        expect(active[0]).toMatchObject({ messageId: b.id, item: 1 });
        expect(active.at(-1)!.actAt).toBe(NOW + (DATED_ACTIVE_MAX - 1) * 1000);
        expect(active.some((r) => r.messageId === b.id && r.item === 0)).toBe(false);
        // plan 210 (iteration 3): a request read after your reply is stored open like any other (only a verdict settles it)
        const replied = await got({ rfcMessageId: "full@x", date: NOW - 9000 });
        await store.sync.ingest([msg({ accountId, from: me, to: [bank], isSent: true, inInbox: false, gmailLabels: ["SENT"], inReplyTo: "full@x", references: ["full@x"], subject: "Re", date: NOW - 8000 })], { applyFilters: false, now: NOW, classifier: null });
        await finish(replied.id, replied.thread, { rows: [item({ kind: "respond", item: 0, actAt: NOW - 1 })] });
        expect((await store.dated.active())[0]).toMatchObject({ messageId: replied.id, kind: "respond", state: "open" });
        expect(await store.dated.active()).toHaveLength(DATED_ACTIVE_MAX);
      });
    });

    describe("reading and changing them", () => {
      it("plan 210 (iteration 3): a message you send settles nothing by itself, from sync or read late, an ask or a request", async () => {
        const { store, accountId, got, item, finish } = await setup();
        const ana = { name: "Ana Ruiz", email: "ana@studio.test" };
        const ask = await got({ from: ana, rfcMessageId: "quote@x", date: NOW - 5000 });
        const asked = item({ kind: "ask", text: "Answer Ana about a quote", quote: "can you send me a quote", dueDay: "2026-11-13", dueAt: NOW - 5000, dated: false, actAt: NOW - 5000 });
        await finish(ask.id, ask.thread, { rows: [asked, item({ kind: "respond", item: 1, text: "Send the deck" })] });
        const [row] = (await store.dated.ofThread(ask.thread)).filter((r) => r.kind === "ask");
        expect(row).toMatchObject({ kind: "ask", text: "Answer Ana about a quote", dated: false, timed: false, state: "open", arrivedAt: ask.m.date });
        await store.sync.ingest([msg({ accountId, from: me, to: [ana], isSent: true, inInbox: false, gmailLabels: ["SENT"], inReplyTo: "quote@x", references: ["quote@x"], subject: "Re", date: NOW - 3000 })], { applyFilters: false, now: NOW, classifier: null });
        expect((await store.dated.ofThread(ask.thread)).map((r) => r.kind).sort()).toEqual(["ask", "respond"]);
        expect(await store.dated.get(row!.id)).toMatchObject({ state: "open", revision: row!.revision });
        // read after your reply: open too
        const late = await got({ from: ana, inReplyTo: "quote@x", references: ["quote@x"], date: NOW - 3500 });
        await finish(late.id, late.thread, { rows: [{ ...asked, text: "Answer Ana about the dates" }] });
        expect(late.thread).toBe(ask.thread);
        expect((await store.dated.ofThread(ask.thread)).map((r) => r.kind).sort()).toEqual(["ask", "ask", "respond"]);
      });

      it("the second panel round: a later message moves your promise's day, only at the revision seen and on its thread", async () => {
        const { store, accountId, got, finish } = await setup();
        // your promise, read from what you sent (plan 142)
        const m = msg({ accountId, from: me, to: [bank], isSent: true, inInbox: false, rfcMessageId: "promise@x", date: NOW - 9000, providerMsgId: "p-sent" });
        const r = await store.sync.ingest([m], { applyFilters: false, now: NOW, classifier: null, liveSent: { wanted: true } });
        const thread = await threadOf(store, "p-sent");
        await store.followups.finish({ messageId: r.inserted[0]!, threadId: thread, fromScan: false, rows: [{ kind: "promise", item: 0, text: "send the script", quote: "I'll send the script", personName: "Bank", personEmail: bank.email, dueAt: NOW - DAY, dated: true }], kept: [], now: NOW, model: "m", provider: "p", promptVersion: 1, clearGeneration: store.followups.clearGeneration() });
        const [promise] = await store.followups.ofThread(thread);
        // "Friday at the latest", from them, on that thread
        const reply = await got({ inReplyTo: "promise@x", references: ["promise@x"], date: NOW - 1000 });
        expect(reply.thread).toBe(thread);
        await finish(reply.id, reply.thread, { movedPromises: [{ id: promise!.id, revision: promise!.revision + 5, dueAt: NOW + 3 * DAY }] });
        expect((await store.followups.get(promise!.id))!.dueAt).toBe(NOW - DAY);
        const again = await got({ inReplyTo: "promise@x", references: ["promise@x"], date: NOW - 500 });
        await finish(again.id, again.thread, { movedPromises: [{ id: promise!.id, revision: promise!.revision, dueAt: NOW + 3 * DAY }] });
        expect(await store.followups.get(promise!.id)).toMatchObject({ dueAt: NOW + 3 * DAY, dated: true, state: "open", revision: promise!.revision + 1 });
        // another thread's message can't move it
        const elsewhere = await got({ date: NOW - 100 });
        await finish(elsewhere.id, elsewhere.thread, { movedPromises: [{ id: promise!.id, revision: promise!.revision + 1, dueAt: NOW + 9 * DAY }] });
        expect((await store.followups.get(promise!.id))!.dueAt).toBe(NOW + 3 * DAY);
      });

      it("plan 210 (iteration 3, revision 4): their later mail replaces your promise with a new request: both in one commit, only as the reader saw it", async () => {
        const { store, accountId, got, item, finish } = await setup();
        const m = msg({ accountId, from: me, to: [bank], isSent: true, inInbox: false, rfcMessageId: "methods@x", date: NOW - 9000, providerMsgId: "methods-sent" });
        const r = await store.sync.ingest([m], { applyFilters: false, now: NOW, classifier: null, liveSent: { wanted: true } });
        const thread = await threadOf(store, "methods-sent");
        await store.followups.finish({ messageId: r.inserted[0]!, threadId: thread, fromScan: false, rows: [{ kind: "promise", item: 0, text: "send the revised methods section", quote: "I'll send the methods section", personName: "Bank", personEmail: bank.email, dueAt: NOW - DAY, dated: true }], kept: [], now: NOW, model: "m", provider: "p", promptVersion: 1, clearGeneration: store.followups.clearGeneration() });
        const [promise] = await store.followups.ofThread(thread);
        const reply = (over: Partial<IncomingMessage> = {}) => got({ inReplyTo: "methods@x", references: ["methods@x"], date: NOW - 1000, ...over });
        const chapter = item({ kind: "respond", text: "Send a full draft of Chapter 2", quote: "please send me a full draft of Chapter 2 by Monday" });
        // refused: a revision since, a request this message doesn't write, another sender in the thread, mail from before it
        const stale = await reply({ date: NOW - 4000 });
        await finish(stale.id, stale.thread, { rows: [chapter], replaced: [{ id: promise!.id, revision: promise!.revision + 1, item: 0 }] });
        const none = await reply({ date: NOW - 3500 });
        await finish(none.id, none.thread, { rows: [], replaced: [{ id: promise!.id, revision: promise!.revision, item: 0 }] });
        const shopReply = await reply({ from: shop, date: NOW - 3000 });
        expect(shopReply.thread).toBe(thread);
        await finish(shopReply.id, shopReply.thread, { rows: [chapter], replaced: [{ id: promise!.id, revision: promise!.revision, item: 0 }] });
        const before = await reply({ date: NOW - 9500 });
        await finish(before.id, before.thread, { rows: [chapter], replaced: [{ id: promise!.id, revision: promise!.revision, item: 0 }] });
        expect(await store.followups.get(promise!.id)).toMatchObject({ state: "open", closedReason: null, revision: promise!.revision });
        // their mail, after it, on its thread, at the revision seen: the promise closes as replaced, the request is open
        const ingrid = await reply();
        await finish(ingrid.id, ingrid.thread, { rows: [chapter], replaced: [{ id: promise!.id, revision: promise!.revision, item: 0 }] });
        expect(await store.followups.get(promise!.id)).toMatchObject({ state: "dismissed", closedReason: "replaced", closedAt: NOW, inboxState: "none", revision: promise!.revision + 1 });
        expect((await store.dated.ofThread(thread)).filter((x) => x.text === "Send a full draft of Chapter 2" && x.state === "open")).not.toHaveLength(0);
        // history reads it as closed
        expect((await store.followups.closedPage({ since: 0, after: null, limit: 10 })).map((p) => [p.id, p.closedReason])).toEqual([[promise!.id, "replaced"]]);
        // closed: a second replacement changes nothing
        const again = await reply({ date: NOW - 500 });
        await finish(again.id, again.thread, { rows: [chapter], replaced: [{ id: promise!.id, revision: promise!.revision + 1, item: 0 }] });
        expect(await store.followups.get(promise!.id)).toMatchObject({ state: "dismissed", revision: promise!.revision + 1 });
      });

      it("the fifth panel round: a promise's Later against a move from their mail, in both orders, and its Undo", async () => {
        const { store, accountId, got, finish } = await setup();
        const m = msg({ accountId, from: me, to: [bank], isSent: true, inInbox: false, rfcMessageId: "later@x", date: NOW - 9000, providerMsgId: "l-sent" });
        const r = await store.sync.ingest([m], { applyFilters: false, now: NOW, classifier: null, liveSent: { wanted: true } });
        const thread = await threadOf(store, "l-sent");
        await store.followups.finish({ messageId: r.inserted[0]!, threadId: thread, fromScan: false, rows: [{ kind: "promise", item: 0, text: "send the script", quote: "I'll send the script", personName: "Bank", personEmail: bank.email, dueAt: NOW + DAY, dated: true }], kept: [], now: NOW, model: "m", provider: "p", promptVersion: 1, clearGeneration: store.followups.clearGeneration() });
        const [p0] = await store.followups.ofThread(thread);
        const reply = (date: number) => got({ inReplyTo: "later@x", references: ["later@x"], date });
        // move, then Later, then Undo: the moved day stays, the deferral goes
        const a = await reply(NOW - 3000);
        await finish(a.id, a.thread, { movedPromises: [{ id: p0!.id, revision: p0!.revision, dueAt: NOW + 3 * DAY }] });
        const p1 = (await store.followups.get(p0!.id))!;
        const later = (await store.followups.update(p1.id, p1.revision, { state: "open", inboxState: "none", deferredUntil: NOW + 5 * DAY }))!;
        expect(await store.followups.get(p0!.id)).toMatchObject({ dueAt: NOW + 3 * DAY, deferredUntil: NOW + 5 * DAY });
        expect(await store.followups.restore([{ snapshot: later, expectRevision: later.revision + 1 }])).toBe(1);
        expect(await store.followups.get(p0!.id)).toMatchObject({ dueAt: NOW + 3 * DAY, deferredUntil: null });
        // Later, then a move read before it: the Later wins, the move is refused, and Later's Undo still applies
        const p2 = (await store.followups.get(p0!.id))!;
        const again = (await store.followups.update(p2.id, p2.revision, { state: "open", inboxState: "none", deferredUntil: NOW + 5 * DAY }))!;
        const b = await reply(NOW - 2000);
        await finish(b.id, b.thread, { movedPromises: [{ id: p2.id, revision: p2.revision, dueAt: NOW + 4 * DAY }] });
        expect(await store.followups.get(p0!.id)).toMatchObject({ dueAt: NOW + 3 * DAY, deferredUntil: NOW + 5 * DAY, revision: p2.revision + 1 });
        // a move read after it lands, keeping the deferral; Later's Undo is then refused (changed since), nothing lost
        const c = await reply(NOW - 1000);
        await finish(c.id, c.thread, { movedPromises: [{ id: p2.id, revision: p2.revision + 1, dueAt: NOW + 4 * DAY }] });
        expect(await store.followups.get(p0!.id)).toMatchObject({ dueAt: NOW + 4 * DAY, deferredUntil: NOW + 5 * DAY, revision: p2.revision + 2 });
        expect(await store.followups.restore([{ snapshot: again, expectRevision: again.revision + 1 }])).toBe(0);
        expect(await store.followups.get(p0!.id)).toMatchObject({ dueAt: NOW + 4 * DAY, deferredUntil: NOW + 5 * DAY });
      });

      it("a later message moves an open item's day whatever its revision, keeping its deferral; never a closed one, nor another sender's", async () => {
        const { store, got, item, finish } = await setup();
        const a = await got();
        await finish(a.id, a.thread, { rows: [item()] });
        const [row] = await store.dated.active();
        // a Later meanwhile: the revision the reader saw is stale, the mail's new day still lands
        const laterUndo = (await store.dated.update(row!.id, row!.revision, { deferredUntil: NOW + 2 * DAY }))!;
        const later = await got({ inReplyTo: a.m.rfcMessageId, references: [a.m.rfcMessageId!], date: NOW - 1000 });
        const moved = { id: row!.id, dueDay: "2026-11-24", dueAt: NOW + 11 * DAY, timed: false, actAt: NOW + 8 * DAY };
        await finish(later.id, later.thread, { moved: [moved] });
        expect(await store.dated.get(row!.id)).toMatchObject({ dueDay: "2026-11-24", dueAt: NOW + 11 * DAY, actAt: NOW + 8 * DAY, deferredUntil: NOW + 2 * DAY, state: "open", revision: row!.revision + 1 });
        // Codex code review of the fixes: the move kept the revision, so Later's Undo still applies, and the new day stays
        expect(await store.dated.restore([{ snapshot: laterUndo, expectRevision: laterUndo.revision + 1 }])).toBe(1);
        expect(await store.dated.get(row!.id)).toMatchObject({ dueDay: "2026-11-24", deferredUntil: null, state: "open", revision: row!.revision + 2 });
        // closed: stays closed
        await store.dated.update(row!.id, row!.revision + 2, { state: "done", closedReason: "user", closedAt: NOW });
        const third = await got({ inReplyTo: a.m.rfcMessageId, references: [a.m.rfcMessageId!], date: NOW - 500 });
        await finish(third.id, third.thread, { moved: [{ ...moved, dueDay: "2026-11-30" }] });
        expect(await store.dated.get(row!.id)).toMatchObject({ state: "done", dueDay: "2026-11-24" });
        // another sender on another thread can't move it
        const b = await got({ date: NOW - 900 });
        await finish(b.id, b.thread, { rows: [item()] });
        const [open] = await store.dated.active();
        const stranger = await got({ from: { name: "Shop", email: "shop@example.com" }, date: NOW - 100 });
        await finish(stranger.id, stranger.thread, { moved: [{ ...moved, id: open!.id }] });
        expect((await store.dated.get(open!.id))!.dueDay).toBe("2026-11-20");
      });

      it("the sixth panel round: a delivery or an ask is material for, and moved or settled by, its own conversation only; there, Later's Undo around a move stays as it was", async () => {
        const { store, got, item, finish } = await setup();
        const thread = (m: { m: IncomingMessage }) => ({ inReplyTo: m.m.rfcMessageId, references: [m.m.rfcMessageId!] });
        const move = (id: number, dueDay: string, days: number) => ({ id, dueDay, dueAt: NOW + days * DAY, timed: false, actAt: NOW + days * DAY });
        // one order's bill, then its parcel (newer), then the shop's next order elsewhere
        const order = await got({ from: shop, date: NOW - 9500 });
        await finish(order.id, order.thread, { rows: [item()] });
        const shipped = await got({ from: shop, ...thread(order), date: NOW - 9000 });
        expect(shipped.thread).toBe(order.thread);
        await finish(shipped.id, shipped.thread, { rows: [item({ kind: "delivery", text: "Your parcel arrives", quote: "arrives Tuesday", dueDay: "2026-11-17", dueAt: NOW + 4 * DAY, actAt: NOW + 4 * DAY })] });
        const rows = await store.dated.ofThread(order.thread);
        const bill = rows.find((r) => r.kind === "pay")!;
        const parcel = rows.find((r) => r.kind === "delivery")!;
        const next = await got({ from: shop, date: NOW - 8000 });
        const src = (await store.dated.source(next.id))!;
        // as context: the bill crosses, the parcel doesn't, and it takes none of the limit
        expect((await store.dated.openFor({ threadId: src.threadId, senderKey: src.senderKey, before: src.date, limit: 1 })).map((r) => r.id)).toEqual([bill.id]);
        // as a write: neither moved nor settled from there
        await finish(next.id, next.thread, { moved: [move(parcel.id, "2026-11-14", 1)], settled: [{ id: parcel.id, revision: parcel.revision }] });
        expect(await store.dated.get(parcel.id)).toMatchObject({ state: "open", dueDay: "2026-11-17", revision: parcel.revision });
        // a person's ask: not from their other conversation, either way
        const mariana = { name: "Mariana Paz", email: "mariana@studio.test" };
        const asked = await got({ from: mariana, date: NOW - 7000 });
        await finish(asked.id, asked.thread, { rows: [item({ kind: "ask", text: "Answer Mariana about the quote", quote: "can you send a quote", dated: false })] });
        const [ask] = await store.dated.ofThread(asked.thread);
        const elsewhere = await got({ from: mariana, date: NOW - 6000 });
        const from = (await store.dated.source(elsewhere.id))!;
        expect(await store.dated.openFor({ threadId: from.threadId, senderKey: from.senderKey, before: from.date, limit: 10 })).toEqual([]);
        await finish(elsewhere.id, elsewhere.thread, { moved: [move(ask!.id, "2026-11-20", 7)], settled: [{ id: ask!.id, revision: ask!.revision }] });
        expect(await store.dated.get(ask!.id)).toMatchObject({ state: "open", dated: false, dueDay: ask!.dueDay, revision: ask!.revision });
        // in its own conversation it is settled
        const there = await got({ from: mariana, ...thread(asked), date: NOW - 5000 });
        await finish(there.id, there.thread, { settled: [{ id: ask!.id, revision: ask!.revision }] });
        expect((await store.dated.get(ask!.id))!.state).toBe("settled");
        // the parcel moves in its own: Later, the move, Undo keeps the move's day and gives back the deferral
        const laterUndo = (await store.dated.update(parcel.id, parcel.revision, { deferredUntil: NOW + DAY }))!;
        const update = await got({ from: shop, ...thread(order), date: NOW - 4000 });
        await finish(update.id, update.thread, { moved: [move(parcel.id, "2026-11-15", 2)] });
        expect(await store.dated.get(parcel.id)).toMatchObject({ dueDay: "2026-11-15", deferredUntil: NOW + DAY });
        expect(await store.dated.restore([{ snapshot: laterUndo, expectRevision: laterUndo.revision + 1 }])).toBe(1);
        expect(await store.dated.get(parcel.id)).toMatchObject({ dueDay: "2026-11-15", deferredUntil: null, state: "open" });
        // the move, Later, Undo
        const again = await got({ from: shop, ...thread(order), date: NOW - 3000 });
        await finish(again.id, again.thread, { moved: [move(parcel.id, "2026-11-16", 3)] });
        const moved = (await store.dated.get(parcel.id))!;
        const later = (await store.dated.update(parcel.id, moved.revision, { deferredUntil: NOW + DAY }))!;
        expect(await store.dated.restore([{ snapshot: later, expectRevision: later.revision + 1 }])).toBe(1);
        expect(await store.dated.get(parcel.id)).toMatchObject({ dueDay: "2026-11-16", deferredUntil: null, state: "open" });
      });

      it("source: who it was sent to, and whether the reader is addressed, only copied, or not named (prompt version 2)", async () => {
        const { store, got } = await setup();
        const oren = { name: "Oren Vale", email: "oren@example.com" };
        const addressed = await got();
        const copied = await got({ to: [oren], cc: [{ name: "Me", email: "ME0+work@example.com" }] });
        const listed = await got({ to: [{ name: "", email: "dev@lists.example.com" }] });
        expect(await store.dated.source(addressed.id)).toMatchObject({ readerIn: "to", to: [me], cc: [] });
        expect(await store.dated.source(copied.id)).toMatchObject({ readerIn: "cc", to: [oren] });
        expect((await store.dated.source(listed.id))!.readerIn).toBe("none");
      });

      it("openFor: open items of the thread or the sender, from older messages, newest first", async () => {
        const { store, accountId, got, item, finish } = await setup();
        const bill = await got({ rfcMessageId: "t1@x", date: NOW - 5000 });
        const elsewhere = await got({ date: NOW - 4000 });
        const order = await got({ from: shop, date: NOW - 3000 });
        const closed = await got({ from: shop, date: NOW - 2500 });
        for (const x of [bill, elsewhere, order, closed]) await finish(x.id, x.thread, { rows: [item()] });
        const done = (await store.dated.ofThread(closed.thread))[0]!;
        await store.dated.update(done.id, done.revision, { state: "done", closedReason: "user", closedAt: NOW });
        // the shop answers on the bill's thread
        const r = await store.sync.ingest([msg({ accountId, from: shop, to: [me], inReplyTo: "t1@x", references: ["t1@x"], subject: "Re", date: NOW - 1000 })], { applyFilters: false, now: NOW, classifier: null });
        const src = (await store.dated.source(r.inserted[0]!))!;
        const of = (before: number, limit = 10) => store.dated.openFor({ threadId: src.threadId, senderKey: src.senderKey, before, limit });
        expect((await of(src.date)).map((x) => x.messageId)).toEqual([order.id, bill.id]);
        expect((await of(src.date, 1)).map((x) => x.messageId)).toEqual([order.id]);
        expect((await of(NOW - 3500)).map((x) => x.messageId)).toEqual([bill.id]);
        // Codex code review: the order's conversation moved to Spam: its item is no request's material any more
        await store.threads.act({ threadIds: [order.thread], action: "spam", signal: null, now: NOW });
        expect((await of(src.date)).map((x) => x.messageId)).toEqual([bill.id]);
      });

      it("an update can require the day it was decided on: retiring what's over after a move changes nothing (Codex review, round 2)", async () => {
        const { store, got, item, finish } = await setup();
        const a = await got();
        await finish(a.id, a.thread, { rows: [item()] });
        const [row] = await store.dated.active();
        const later = await got({ inReplyTo: a.m.rfcMessageId, references: [a.m.rfcMessageId!], date: NOW - 1000 });
        await finish(later.id, later.thread, { moved: [{ id: row!.id, dueDay: "2026-12-04", dueAt: NOW + 21 * DAY, timed: false, actAt: NOW + 18 * DAY }] });
        // the revision is the same, the day isn't: what was decided on the old day doesn't apply
        expect(await store.dated.update(row!.id, row!.revision, { state: "dismissed", closedReason: "expired", closedAt: NOW }, { dueDay: row!.dueDay, dueAt: row!.dueAt })).toBeNull();
        expect((await store.dated.get(row!.id))!.state).toBe("open");
        expect(await store.dated.update(row!.id, row!.revision, { state: "dismissed", closedReason: "expired", closedAt: NOW }, { dueDay: "2026-12-04", dueAt: NOW + 21 * DAY })).not.toBeNull();
      });

      it("the fourth panel round: a move to a new moment on the same day keeps the item and its Later; what was decided at the old moment doesn't apply", async () => {
        const { store, got, item, finish } = await setup();
        const a = await got();
        await finish(a.id, a.thread, { rows: [item({ kind: "event", dueAt: NOW + 7 * DAY + 2 * 3_600_000, timed: true })] });
        const [row] = await store.dated.active();
        const laterUndo = (await store.dated.update(row!.id, row!.revision, { deferredUntil: NOW + 2 * DAY }))!;
        const later = await got({ inReplyTo: a.m.rfcMessageId, references: [a.m.rfcMessageId!], date: NOW - 1000 });
        await finish(later.id, later.thread, { moved: [{ id: row!.id, dueDay: "2026-11-20", dueAt: NOW + 7 * DAY, timed: true, actAt: NOW + 6 * DAY }] });
        expect(await store.dated.get(row!.id)).toMatchObject({ dueDay: "2026-11-20", dueAt: NOW + 7 * DAY, timed: true, deferredUntil: NOW + 2 * DAY, revision: row!.revision + 1 });
        expect(await store.dated.update(row!.id, row!.revision + 1, { state: "dismissed", closedReason: "expired", closedAt: NOW }, { dueDay: "2026-11-20", dueAt: row!.dueAt })).toBeNull();
        expect(await store.dated.restore([{ snapshot: laterUndo, expectRevision: laterUndo.revision + 1 }])).toBe(1);
        expect(await store.dated.get(row!.id)).toMatchObject({ dueAt: NOW + 7 * DAY, deferredUntil: null, state: "open" });
      });

      it("the fifth panel round: a move writes the item's new words with its day; without them the words stay; Undo of a Later, before or after, keeps both", async () => {
        const { store, got, item, finish } = await setup();
        const game = { kind: "event" as const, text: "Soccer game (arrive 9:30)", dueAt: NOW + 7 * DAY + 2 * 3_600_000, timed: true };
        // Later, then the move, then Undo
        const a = await got();
        await finish(a.id, a.thread, { rows: [item(game)] });
        const [row] = await store.dated.ofThread(a.thread);
        const laterUndo = (await store.dated.update(row!.id, row!.revision, { deferredUntil: NOW + 2 * DAY }))!;
        const moving = await got({ inReplyTo: a.m.rfcMessageId, references: [a.m.rfcMessageId!], date: NOW - 1000 });
        const move = { id: row!.id, dueDay: "2026-11-20", dueAt: NOW + 7 * DAY, timed: true, actAt: NOW + 6 * DAY, text: "Soccer game (arrive 7:30)" };
        await finish(moving.id, moving.thread, { moved: [move] });
        expect(await store.dated.get(row!.id)).toMatchObject({ text: "Soccer game (arrive 7:30)", dueAt: NOW + 7 * DAY, deferredUntil: NOW + 2 * DAY, quote: "due on November 20" });
        expect(await store.dated.restore([{ snapshot: laterUndo, expectRevision: laterUndo.revision + 1 }])).toBe(1);
        expect(await store.dated.get(row!.id)).toMatchObject({ text: "Soccer game (arrive 7:30)", dueAt: NOW + 7 * DAY, deferredUntil: null, state: "open" });
        // a later move with no words keeps the ones it has
        const again = await got({ inReplyTo: a.m.rfcMessageId, references: [a.m.rfcMessageId!], date: NOW - 900 });
        await finish(again.id, again.thread, { moved: [{ id: row!.id, dueDay: "2026-11-21", dueAt: NOW + 8 * DAY, timed: true, actAt: NOW + 7 * DAY }] });
        expect(await store.dated.get(row!.id)).toMatchObject({ text: "Soccer game (arrive 7:30)", dueDay: "2026-11-21" });
        // the move, then Later, then Undo
        const b = await got({ date: NOW - 800 });
        await finish(b.id, b.thread, { rows: [item(game)] });
        const other = (await store.dated.ofThread(b.thread)).find((r) => r.messageId === b.id);
        const movingB = await got({ inReplyTo: b.m.rfcMessageId, references: [b.m.rfcMessageId!], date: NOW - 700 });
        await finish(movingB.id, movingB.thread, { moved: [{ ...move, id: other!.id }] });
        const moved = (await store.dated.get(other!.id))!;
        const laterB = (await store.dated.update(other!.id, moved.revision, { deferredUntil: NOW + 2 * DAY }))!;
        expect(await store.dated.restore([{ snapshot: laterB, expectRevision: laterB.revision + 1 }])).toBe(1);
        expect(await store.dated.get(other!.id)).toMatchObject({ text: "Soccer game (arrive 7:30)", dueAt: NOW + 7 * DAY, deferredUntil: null, state: "open" });
      });

      it("the seventh panel round: Done, Later, a move between and their Undos leave the row whose own day groups it: Soon, Coming up while put off, Today once moved to today", async () => {
        const { store, got, item, finish } = await setup();
        // the groups are read in the machine's own days
        const local = (day: number, hour = 9) => new Date(2026, 10, day, hour).getTime();
        const at = local(15, 10);
        const a = await got();
        await finish(a.id, a.thread, { rows: [item({ dueDay: "2026-11-20", dueAt: local(20), actAt: local(13) })] });
        const [row] = await store.dated.ofThread(a.thread);
        const group = async () => datedGroupAt((await store.dated.get(row!.id))!, at)?.group ?? null;
        expect(await group()).toBe("day");
        const done = (await store.dated.update(row!.id, row!.revision, { state: "done", closedReason: "user", closedAt: at }))!;
        expect(await group()).toBeNull();
        expect(await store.dated.restore([{ snapshot: done, expectRevision: done.revision + 1 }])).toBe(1);
        expect(await group()).toBe("day");
        // Later, then their mail moves it to today at 5 PM, then Later's Undo: today's, at its new moment
        const back = (await store.dated.get(row!.id))!;
        const later = (await store.dated.update(row!.id, back.revision, { deferredUntil: local(17) }))!;
        expect(await group()).toBe("comingUp");
        const moving = await got({ inReplyTo: a.m.rfcMessageId, references: [a.m.rfcMessageId!], date: NOW - 1000 });
        await finish(moving.id, moving.thread, { moved: [{ id: row!.id, dueDay: "2026-11-15", dueAt: local(15, 17), timed: true, actAt: local(14) }] });
        expect(await group()).toBe("comingUp");
        expect(await store.dated.restore([{ snapshot: later, expectRevision: later.revision + 1 }])).toBe(1);
        expect(await store.dated.get(row!.id)).toMatchObject({ dueDay: "2026-11-15", dueAt: local(15, 17), timed: true, deferredUntil: null, state: "open" });
        expect(await group()).toBe("today");
        // Done on it now, and its Undo: Today's again, exactly
        const now = (await store.dated.get(row!.id))!;
        const doneToday = (await store.dated.update(row!.id, now.revision, { state: "done", closedReason: "user", closedAt: at }))!;
        expect(await group()).toBeNull();
        expect(await store.dated.restore([{ snapshot: doneToday, expectRevision: doneToday.revision + 1 }])).toBe(1);
        expect(await group()).toBe("today");
      });

      it("a change applies only at the revision seen; Undo restores exactly, unless something changed it since", async () => {
        const { store, got, item, finish } = await setup();
        const a = await got();
        await finish(a.id, a.thread, { rows: [item()] });
        const [row] = await store.dated.active();
        expect(await store.dated.update(row!.id, row!.revision + 7, { state: "done" })).toBeNull();
        const later = (await store.dated.update(row!.id, row!.revision, { deferredUntil: NOW + 5 * DAY }))!;
        expect(await store.dated.get(row!.id)).toMatchObject({ deferredUntil: NOW + 5 * DAY, revision: row!.revision + 1, state: "open" });
        const before = (await store.dated.update(row!.id, row!.revision + 1, { state: "done", closedReason: "user", closedAt: NOW }))!;
        expect(before).toEqual({ id: row!.id, revision: row!.revision + 1, state: "open", deferredUntil: NOW + 5 * DAY, closedReason: null, closedAt: null });
        expect(await store.dated.active()).toEqual([]);
        // the older Undo is refused: something changed the row since
        expect(await store.dated.restore([{ snapshot: later, expectRevision: later.revision + 1 }])).toBe(0);
        expect(await store.dated.restore([{ snapshot: before, expectRevision: before.revision + 1 }])).toBe(1);
        expect(await store.dated.get(row!.id)).toMatchObject({ state: "open", deferredUntil: NOW + 5 * DAY, closedReason: null, closedAt: null, revision: row!.revision + 3 });
        expect(await store.dated.restore([{ snapshot: before, expectRevision: before.revision + 1 }])).toBe(0);
        await store.dated.update(row!.id, row!.revision + 3, { deferredUntil: null });
        expect((await store.dated.get(row!.id))!.deferredUntil).toBeNull();
      });

      it("active: open only, soonest act-at first", async () => {
        const { store, got, item, finish } = await setup();
        const a = await got();
        await finish(a.id, a.thread, { rows: [item({ item: 0, actAt: NOW + 3000 }), item({ item: 1, actAt: NOW + 1000 }), item({ item: 2, actAt: NOW + 1000 }), item({ item: 3, actAt: NOW + 2000 })] });
        const rows = await store.dated.active();
        expect(rows.map((r) => r.item)).toEqual([1, 2, 3, 0]);
        await store.dated.update(rows[0]!.id, rows[0]!.revision, { state: "dismissed", closedReason: "user", closedAt: NOW });
        expect((await store.dated.active()).map((r) => r.item)).toEqual([2, 3, 0]);
      });

      it("items outlive their message, never their thread; closed ones go after 90 days", async () => {
        const { store, other, got, item, finish } = await setup();
        const a = await got({ rfcMessageId: "k@x" });
        await got({ inReplyTo: "k@x", references: ["k@x"], subject: "Re", date: NOW - 1000 }, null);
        await finish(a.id, a.thread, { rows: [item(), item({ item: 1 })] });
        await store.sync.remove([a.id]);
        const rows = await store.dated.ofThread(a.thread);
        expect(rows).toHaveLength(2);
        await store.dated.update(rows[0]!.id, rows[0]!.revision, { state: "done", closedReason: "user", closedAt: NOW });
        expect(await store.dated.prune(NOW + DATED_CLOSED_KEEP_MS)).toBe(0);
        expect(await store.dated.prune(NOW + DATED_CLOSED_KEEP_MS + 1)).toBe(1);
        expect(await store.dated.active()).toHaveLength(1);
        // another account's thread, removed with it
        const m = msg({ accountId: other, from: bank, to: [me], date: NOW - 1000 });
        const r = await store.sync.ingest([m], { applyFilters: false, now: NOW, classifier: null, datedMail: { since: null } });
        await finish(r.inserted[0]!, await threadOf(store, m.providerMsgId!), { rows: [item()] });
        expect(await store.dated.active()).toHaveLength(2);
        await store.accounts.remove(other);
        expect((await store.dated.active()).map((x) => x.threadId)).toEqual([a.thread]);
      });
    });
    describe("the history's reads (plan 210)", () => {
      /** items on their own threads, closed at these moments (null: left open), the rows newest first as they'll page */
      async function closedItems(at: (number | null)[], state: "done" | "dismissed" | "settled" = "done") {
        const s = await setup();
        const rows: { id: number; thread: number; at: number | null }[] = [];
        for (const [i, when] of at.entries()) {
          const m = await s.got({ subject: `Bill ${i}`, providerMsgId: `h-${i}` });
          await s.finish(m.id, m.thread, { rows: [s.item()] });
          const [row] = await s.store.dated.ofThread(m.thread);
          if (when !== null) await s.store.dated.update(row!.id, row!.revision, { state, closedReason: state === "dismissed" ? "user" : state, closedAt: when });
          rows.push({ id: row!.id, thread: m.thread, at: when });
        }
        return { ...s, rows };
      }

      it("pages closed rows newest first by closing time then id, strictly after a key, never an open one nor one closed before the window", async () => {
        const { store, rows } = await closedItems([NOW - 3000, NOW - 1000, null, NOW - 1000, NOW - 2 * DATED_CLOSED_KEEP_MS, NOW - 2000]);
        const want = rows.filter((r) => r.at !== null && r.at >= NOW - DATED_CLOSED_KEEP_MS).sort((a, b) => b.at! - a.at! || b.id - a.id).map((r) => r.id);
        const since = NOW - DATED_CLOSED_KEEP_MS;
        expect((await store.dated.closedPage({ since, after: null, limit: 10 })).map((r) => r.id)).toEqual(want);
        // two at a time, each page strictly after the last one's key: every row once, in order
        const paged: number[] = [];
        let after: { at: number; id: number } | null = null;
        for (;;) {
          const page = await store.dated.closedPage({ since, after, limit: 2 });
          if (!page.length) break;
          paged.push(...page.map((r) => r.id));
          const last = page.at(-1)!;
          after = { at: last.closedAt!, id: last.id };
        }
        expect(paged).toEqual(want);
        // the same moment: the higher id first, and a key between them splits them
        const [a, b] = rows.filter((r) => r.at === NOW - 1000).sort((x, y) => y.id - x.id);
        expect((await store.dated.closedPage({ since, after: { at: NOW - 1000, id: a!.id }, limit: 1 })).map((r) => r.id)).toEqual([b!.id]);
      });

      it("takes every closed state, two closings of one conversation each a row of their own, and a reopened one leaves", async () => {
        const s = await closedItems([NOW - 5000], "settled");
        const m = await s.got({ subject: "Two items", providerMsgId: "h-two" });
        await s.finish(m.id, m.thread, { rows: [s.item(), s.item({ item: 1, text: "Renew the domain" })] });
        const [first, second] = await s.store.dated.ofThread(m.thread);
        await s.store.dated.update(first!.id, first!.revision, { state: "dismissed", closedReason: "expired", closedAt: NOW - 4000 });
        await s.store.dated.update(second!.id, second!.revision, { state: "done", closedReason: "user", closedAt: NOW - 100 });
        const since = NOW - DATED_CLOSED_KEEP_MS;
        expect((await s.store.dated.closedPage({ since, after: null, limit: 10 })).map((r) => [r.id, r.state])).toEqual([[second!.id, "done"], [first!.id, "dismissed"], [s.rows[0]!.id, "settled"]]);
        // reopened (Undo), it leaves the page, and the conversation's other closing stays
        const back = await s.store.dated.get(second!.id);
        await s.store.dated.update(back!.id, back!.revision, { state: "open", closedReason: null, closedAt: null });
        expect((await s.store.dated.closedPage({ since, after: null, limit: 10 })).map((r) => r.id)).toEqual([first!.id, s.rows[0]!.id]);
      });
    });

    describe("What matters' items (plan 210, iteration 2)", () => {
      /** a dated item and two promises of yours, each on a conversation of its own, plus a second dated item */
      async function items() {
        const s = await setup();
        const promise = async (key: string, over: { text?: string; timed?: boolean; dueAt?: number; item?: number } = {}) => {
          const m = msg({ accountId: s.accountId, from: me, to: [bank], isSent: true, inInbox: false, rfcMessageId: `${key}@x`, date: NOW - 9000, providerMsgId: `${key}-sent` });
          const r = await s.store.sync.ingest([m], { applyFilters: false, now: NOW, classifier: null, liveSent: { wanted: true } });
          const thread = await threadOf(s.store, `${key}-sent`);
          await s.store.followups.finish({ messageId: r.inserted[0]!, threadId: thread, fromScan: false, rows: [{ kind: "promise", item: over.item ?? 0, text: over.text ?? "send the slip and $12", quote: "I'll send the slip", personName: "Bank", personEmail: bank.email, dueAt: over.dueAt ?? NOW + DAY, dated: true, ...(over.timed !== undefined ? { timed: over.timed } : {}) }], kept: [], now: NOW, model: "m", provider: "p", promptVersion: 1, clearGeneration: s.store.followups.clearGeneration() });
          return { thread, row: (await s.store.followups.ofThread(thread))[0]! };
        };
        const dated = async (key: string, over: Partial<DatedWrite> = {}) => {
          const m = await s.got({ providerMsgId: key, subject: key });
          await s.finish(m.id, m.thread, { rows: [s.item(over)] });
          return (await s.store.dated.ofThread(m.thread))[0]!;
        };
        return { ...s, promise, dated };
      }

      it("an item read early keeps it, and a promise's stated time and its first broken day round-trip", async () => {
        const { store, dated, promise, got, finish } = await items();
        const early = await dated("early", { kind: "respond", early: true });
        expect(early.early).toBe(true);
        expect((await dated("plain")).early).toBe(false);
        expect(early).toMatchObject({ sameAs: null, detailOf: null });
        // plan 210 (iteration 3): what lapses unless renewed is kept as read; an item read without it doesn't
        expect((await dated("lapses", { kind: "renew", lapses: true })).lapses).toBe(true);
        expect(early.lapses).toBe(false);
        const timed = await promise("timed", { timed: true });
        expect(timed.row).toMatchObject({ timed: true, sameAs: null, brokenDueAt: null });
        expect((await promise("untimed", { text: "send the deck" })).row.timed).toBe(false);
        // broken (its day over when their mail came) and moved: the first broken day is kept, a second move doesn't take it
        const late = await promise("late", { dueAt: NOW - 2 * DAY });
        const reply = (date: number) => got({ inReplyTo: "late@x", references: ["late@x"], date });
        const a = await reply(NOW - 3000);
        await finish(a.id, a.thread, { movedPromises: [{ id: late.row.id, revision: late.row.revision, dueAt: NOW + 3 * DAY, brokenDueAt: NOW - 2 * DAY, timed: true }] });
        expect(await store.followups.get(late.row.id)).toMatchObject({ dueAt: NOW + 3 * DAY, brokenDueAt: NOW - 2 * DAY, timed: true, revision: late.row.revision + 1 });
        const b = await reply(NOW - 2000);
        await finish(b.id, b.thread, { movedPromises: [{ id: late.row.id, revision: late.row.revision + 1, dueAt: NOW + 5 * DAY, brokenDueAt: NOW + 3 * DAY }] });
        // no `timed`: as it was
        expect(await store.followups.get(late.row.id)).toMatchObject({ dueAt: NOW + 5 * DAY, brokenDueAt: NOW - 2 * DAY, timed: true });
        // a move that wasn't after a broken day leaves none
        const fresh = await promise("fresh", { dueAt: NOW + DAY });
        const c = await got({ inReplyTo: "fresh@x", references: ["fresh@x"], date: NOW - 1000 });
        await finish(c.id, c.thread, { movedPromises: [{ id: fresh.row.id, revision: fresh.row.revision, dueAt: NOW + 2 * DAY, brokenDueAt: null }] });
        expect(await store.followups.get(fresh.row.id)).toMatchObject({ dueAt: NOW + 2 * DAY, brokenDueAt: null, timed: false });
      });

      it("links duplicates to a canonical and details to their item, on open rows only, never over one set nor in a chain, and the revision stays", async () => {
        const { store, dated, promise } = await items();
        const bill = await dated("bill", { text: "Pay $12 for the bus" });
        const slip = await promise("slip");
        const dinner = await dated("dinner", { kind: "event", text: "Dinner at Nopa" });
        const mention = await dated("mention", { kind: "event", text: "Dinner with Jess at Nopa" });
        const outbound = await dated("outbound", { kind: "event", text: "Flight to Austin" });
        const back = await dated("back", { kind: "event", text: "Return flight from Austin" });
        const closed = await dated("closed");
        await store.dated.update(closed.id, closed.revision, { state: "done", closedReason: "user", closedAt: NOW });
        const n = await store.today.link({
          same: [
            { item: { source: "promise", id: slip.row.id }, sameAs: `dated:${bill.id}` },
            { item: { source: "dated", id: mention.id }, sameAs: `dated:${dinner.id}` },
            // closed: never linked
            { item: { source: "dated", id: closed.id }, sameAs: `dated:${dinner.id}` },
            // a chain: the target is itself a member
            { item: { source: "dated", id: outbound.id }, sameAs: `dated:${mention.id}` },
            // the canonical of others isn't made anyone's
            { item: { source: "dated", id: dinner.id }, sameAs: `dated:${bill.id}` },
            // no such target, and not itself
            { item: { source: "dated", id: outbound.id }, sameAs: "dated:987654" },
            { item: { source: "dated", id: outbound.id }, sameAs: `dated:${outbound.id}` },
          ],
          details: [{ id: back.id, detailOf: outbound.id }, { id: outbound.id, detailOf: outbound.id }, { id: closed.id, detailOf: outbound.id }],
        });
        expect(n).toBe(3);
        expect(await store.followups.get(slip.row.id)).toMatchObject({ sameAs: `dated:${bill.id}`, revision: slip.row.revision });
        expect(await store.dated.get(mention.id)).toMatchObject({ sameAs: `dated:${dinner.id}`, revision: mention.revision });
        expect(await store.dated.get(back.id)).toMatchObject({ detailOf: outbound.id, revision: back.revision });
        for (const id of [dinner.id, bill.id, outbound.id, closed.id]) expect((await store.dated.get(id))!.sameAs).toBeNull();
        // never over one already set
        expect(await store.today.link({ same: [{ item: { source: "dated", id: mention.id }, sameAs: `dated:${bill.id}` }], details: [{ id: back.id, detailOf: bill.id }] })).toBe(0);
        expect((await store.dated.get(mention.id))!.sameAs).toBe(`dated:${dinner.id}`);
        // members: each canonical's own row and its members, in any state; nothing else
        await store.dated.update(mention.id, mention.revision, { state: "done", closedReason: "user", closedAt: NOW });
        const found = await store.today.members([`dated:${dinner.id}`, `dated:${bill.id}`, "promise:987654", "nonsense"]);
        expect(found.dated.map((r) => r.id)).toEqual([bill.id, dinner.id, mention.id].sort((a, b) => a - b));
        expect(found.promises.map((r) => r.id)).toEqual([slip.row.id]);
        expect(await store.today.members([`promise:${slip.row.id}`])).toMatchObject({ dated: [], promises: [{ id: slip.row.id }] });
        expect(await store.today.members([])).toEqual({ dated: [], promises: [] });
      });

      it("acts on a dated item and a promise at once, all or none, and its Undo restores both only while neither changed", async () => {
        const { store, dated, promise } = await items();
        const bill = await dated("bill");
        const slip = await promise("slip");
        const changes = (billRevision: number, slipRevision: number) => ({
          dated: [{ id: bill.id, revision: billRevision, patch: { state: "done" as const, closedReason: "user", closedAt: NOW } }],
          promises: [{ id: slip.row.id, revision: slipRevision, patch: { state: "done" as const, inboxState: "none" as const, closedReason: "user", closedAt: NOW } }],
        });
        // one stale: nothing changes
        expect(await store.today.act(changes(bill.revision, slip.row.revision + 1))).toBeNull();
        expect(await store.dated.get(bill.id)).toMatchObject({ state: "open", revision: bill.revision });
        expect(await store.followups.get(slip.row.id)).toMatchObject({ state: "open", revision: slip.row.revision });
        const snapshots = await store.today.act(changes(bill.revision, slip.row.revision));
        expect(snapshots).toEqual({
          dated: [{ id: bill.id, revision: bill.revision, state: "open", deferredUntil: null, closedReason: null, closedAt: null }],
          promises: [{ id: slip.row.id, revision: slip.row.revision, state: "open", dueAt: slip.row.dueAt, deferredUntil: null, inboxState: "none", closedReason: null, closedAt: null }],
        });
        expect(await store.dated.get(bill.id)).toMatchObject({ state: "done", closedAt: NOW, revision: bill.revision + 1 });
        expect(await store.followups.get(slip.row.id)).toMatchObject({ state: "done", closedAt: NOW, revision: slip.row.revision + 1 });
        // its Undo: both back, exactly (each a revision on)
        expect(await store.today.restore(snapshots!)).toBe(true);
        expect(await store.dated.get(bill.id)).toMatchObject({ state: "open", closedAt: null, closedReason: null, revision: bill.revision + 2 });
        expect(await store.followups.get(slip.row.id)).toMatchObject({ state: "open", closedAt: null, revision: slip.row.revision + 2 });
        // done again, then one changed since: the Undo restores neither
        const again = (await store.today.act(changes(bill.revision + 2, slip.row.revision + 2)))!;
        await store.followups.update(slip.row.id, slip.row.revision + 3, { closedReason: "kept" });
        expect(await store.today.restore(again)).toBe(false);
        expect((await store.dated.get(bill.id))!.state).toBe("done");
        expect((await store.followups.get(slip.row.id))!.state).toBe("done");
        const now = (await store.followups.get(slip.row.id))!;
        await store.followups.update(now.id, now.revision, { state: "open", closedReason: null, closedAt: null });
        // a Later on one alone, and an empty act, are fine
        const later = await store.today.act({ dated: [], promises: [{ id: slip.row.id, revision: now.revision + 1, patch: { deferredUntil: NOW + DAY } }] });
        expect(later?.promises).toHaveLength(1);
        expect((await store.followups.get(slip.row.id))!.deferredUntil).toBe(NOW + DAY);
        expect(await store.today.act({ dated: [], promises: [] })).toEqual({ dated: [], promises: [] });
      });
    });
    describe("a reply's verdict on a request (plan 210, iteration 3)", () => {
      /** a request of the reader's, and your replies on its conversation; follow-ups' finish on a reply */
      async function talk() {
        const s = await setup();
        const { store, accountId, got, item, finish } = s;
        const asked = await got({ rfcMessageId: "ask@v", date: NOW - 9000 });
        await finish(asked.id, asked.thread, { rows: [item({ kind: "respond", text: "Send the signed form", dueDay: "2026-11-20" }), item({ kind: "pay", item: 1 })] });
        const rows = await store.dated.ofThread(asked.thread);
        const request = rows.find((r) => r.kind === "respond")!;
        const bill = rows.find((r) => r.kind === "pay")!;
        let n = 0;
        const reply = async (over: Partial<IncomingMessage> = {}, at = NOW - 5000 + n * 100, liveSent: { wanted: boolean } | null = { wanted: true }) => {
          n++;
          const m = msg({ accountId, from: me, to: [bank], isSent: true, inInbox: false, gmailLabels: ["SENT"], inReplyTo: "ask@v", references: ["ask@v"], subject: "Re", date: at, ...over });
          const r = await store.sync.ingest([m], { applyFilters: false, now: NOW, classifier: null, ...(liveSent ? { liveSent } : {}) });
          return { id: r.inserted[0]!, thread: await threadOf(store, m.providerMsgId!) };
        };
        const read = (r: { id: number; thread: number }, over: Partial<FollowupFinish> = {}) =>
          store.followups.finish({ messageId: r.id, threadId: r.thread, fromScan: false, rows: [], kept: [], now: NOW, model: "m", provider: "p", promptVersion: 11, clearGeneration: store.followups.clearGeneration(), ...over });
        const promise = (over: Partial<FollowupWrite> = {}): FollowupWrite => ({ kind: "promise", item: 0, text: "send the bank the signed form", quote: "I'll send it Wednesday", personName: "Bank", personEmail: bank.email, dueAt: NOW + DAY, dated: true, ...over });
        return { ...s, asked, request, bill, reply, read, promise };
      }

      it("a send settles nothing; its verdict settles only the request it was shown, at its revision, of its conversation and from before it", async () => {
        const { store, got, item, finish, asked, request, bill, reply, read } = await talk();
        const elsewhere = await got({ date: NOW - 8000 });
        await finish(elsewhere.id, elsewhere.thread, { rows: [item({ kind: "respond", text: "Answer Tom" })] });
        const [other] = await store.dated.ofThread(elsewhere.thread);
        const r = await reply();
        expect(r.thread).toBe(asked.thread);
        expect(await store.dated.get(request.id)).toMatchObject({ state: "open", revision: request.revision });
        // a request after it, a bill, another conversation's, a revision since: nothing
        const after = await got({ inReplyTo: "ask@v", references: ["ask@v"], date: NOW - 1000 });
        await finish(after.id, after.thread, { rows: [item({ kind: "respond", text: "Send the copy too" })] });
        const later = (await store.dated.ofThread(asked.thread)).find((x) => x.messageId === after.id)!;
        const v = (row: { id: number; revision: number }) => ({ request: { id: row.id, revision: row.revision }, verdict: "fulfilled" as const });
        expect(await read(r, { verdicts: [v(later), v(bill), v(other!), { ...v(request), request: { id: request.id, revision: request.revision + 1 } }] })).toBe("written");
        for (const x of [request, later, bill, other!]) expect(await store.dated.get(x.id)).toMatchObject({ state: "open", revision: x.revision });
        // read again: its verdict on the request it answers
        await store.followups.marks.queueScan([r.id], NOW);
        await read(r, { verdicts: [v(request)] });
        expect(await store.dated.get(request.id)).toMatchObject({ state: "settled", closedReason: "answered", closedAt: NOW, revision: request.revision + 1 });
      });

      it("a promise answers it: the request stays open, linked once; a kept promise settles it; a holding reply or none leaves it", async () => {
        const { store, request, reply, read, promise } = await talk();
        const first = await reply();
        await read(first, { rows: [promise(), promise({ item: 1, text: "check and get back to the bank", quote: "let me check" })], verdicts: [{ request: { id: request.id, revision: request.revision }, verdict: "promise", item: 0 }] });
        const promises = await store.followups.ofThread(first.thread);
        const sends = promises.find((p) => p.item === 0)!;
        expect(sends).toMatchObject({ answers: request.id, revision: 0 });
        expect(promises.find((p) => p.item === 1)!.answers).toBeNull();
        expect(await store.dated.get(request.id)).toMatchObject({ state: "open", revision: request.revision });
        // another reply's promise answers it too (each carries its day); the first keeps its link
        const second = await reply();
        await read(second, { rows: [promise({ text: "send it Friday" })], verdicts: [{ request: { id: request.id, revision: request.revision }, verdict: "promise", item: 0 }] });
        expect((await store.followups.ofThread(second.thread)).filter((p) => p.answers === request.id)).toHaveLength(2);
        expect((await store.followups.get(sends.id))!.answers).toBe(request.id);
        // "Here it is": the promise kept, the request answered with it
        const third = await reply();
        await read(third, { kept: [{ id: sends.id, revision: sends.revision }] });
        expect(await store.followups.get(sends.id)).toMatchObject({ state: "done", closedReason: "kept" });
        expect(await store.dated.get(request.id)).toMatchObject({ state: "settled", closedReason: "answered", revision: request.revision + 1 });
      });

      it("only a reply that's yours for certain decides: a forged From or another IMAP client's send doesn't; Terno's own confirmed send does", async () => {
        const { store, accountId, asked, request, reply, read } = await talk();
        const v = { request: { id: request.id, revision: request.revision }, verdict: "fulfilled" as const };
        const imap = await reply({ gmailLabels: [] });
        await read(imap, { verdicts: [v] });
        expect((await store.dated.get(request.id))!.state).toBe("open");
        const send = await store.compose.queueSend({ accountId, to: [bank], cc: [], bcc: [], subject: "Re", bodyText: "Here it is", inReplyToMessageId: asked.id, recordReply: false, now: NOW });
        expect(send.threadId).toBe(asked.thread);
        await store.ops.claimReady(NOW, 20);
        await store.ops.complete(send.opId, { providerMsgId: "confirmed-1" }, NOW, { followup: true });
        expect((await store.followups.marks.page(null, 10)).map((m) => m.messageId)).toContain(send.messageId);
        expect(await read({ id: send.messageId, thread: send.threadId }, { verdicts: [v] })).toBe("written");
        expect(await store.dated.get(request.id)).toMatchObject({ state: "settled", closedReason: "answered" });
      });

      it("a request read after replies of yours marks the first few again for their verdict: yours for certain, since follow-ups went on, not marked now", async () => {
        const { store, accountId, got, item, finish } = await setup();
        const asked = await got({ rfcMessageId: "late@v", date: NOW - 20_000 });
        const sent = async (at: number, over: Partial<IncomingMessage> = {}) => {
          const m = msg({ accountId, from: me, to: [bank], isSent: true, inInbox: false, gmailLabels: ["SENT"], inReplyTo: "late@v", references: ["late@v"], subject: "Re", date: at, ...over });
          return (await store.sync.ingest([m], { applyFilters: false, now: NOW, classifier: null })).inserted[0]!;
        };
        const before = await sent(NOW - 19_000);
        const forged = await sent(NOW - 18_000, { gmailLabels: [] });
        const replies = [await sent(NOW - 17_000), await sent(NOW - 16_000), await sent(NOW - 15_000), await sent(NOW - 14_000)];
        const marked = async () => (await store.followups.marks.page(null, 20)).map((m) => m.messageId);
        expect(await marked()).toEqual([]);
        // a bill read late, or follow-ups off: nothing
        await finish(asked.id, asked.thread, { rows: [item({ kind: "pay" })], replies: { since: NOW - 18_500 } });
        expect(await marked()).toEqual([]);
        const again = await got({ inReplyTo: "late@v", references: ["late@v"], date: NOW - 19_500 });
        await finish(again.id, again.thread, { rows: [item({ kind: "respond" })] });
        expect(await marked()).toEqual([]);
        // a request: the first three since then, not the forged one nor one from before
        const third = await got({ inReplyTo: "late@v", references: ["late@v"], date: NOW - 19_400 });
        await finish(third.id, third.thread, { rows: [item({ kind: "ask", dated: false })], replies: { since: NOW - 18_500 } });
        expect(await marked()).toEqual(replies.slice(0, 3));
        expect(await marked()).not.toContain(before);
        expect(await marked()).not.toContain(forged);
      });

      it("Codex code review: Terno's confirmed send stays yours for certain once read, so a request read later gets its verdict", async () => {
        const { store, accountId, got, item, finish } = await setup();
        const asked = await got({ rfcMessageId: "conf@v", date: NOW - 20_000 }, null);
        const send = await store.compose.queueSend({ accountId, to: [bank], cc: [], bcc: [], subject: "Re", bodyText: "Here it is", inReplyToMessageId: asked.id, recordReply: false, now: NOW });
        expect(send.threadId).toBe(asked.thread);
        await store.ops.claimReady(NOW, 20);
        await store.ops.complete(send.opId, { providerMsgId: "confirmed-2" }, NOW, { followup: true });
        // read with nothing to say (the dated reader paused): its mark consumed
        const read = (over: Partial<FollowupFinish> = {}) => store.followups.finish({ messageId: send.messageId, threadId: send.threadId, fromScan: false, rows: [], kept: [], now: NOW, model: "m", provider: "p", promptVersion: 11, clearGeneration: store.followups.clearGeneration(), ...over });
        expect(await read()).toBe("written");
        expect(await store.followups.marks.page(null, 10)).toEqual([]);
        // the request read late: the confirmed reply is read again, and its verdict decides
        const later = await got({ inReplyTo: "conf@v", references: ["conf@v"], date: NOW - 19_000 });
        await finish(later.id, later.thread, { rows: [item({ kind: "respond", text: "Send the signed form" })], replies: { since: NOW - 30_000 } });
        expect((await store.followups.marks.page(null, 10)).map((m) => m.messageId)).toEqual([send.messageId]);
        const [request] = (await store.dated.ofThread(asked.thread)).filter((x) => x.kind === "respond");
        expect(await read({ verdicts: [{ request: { id: request!.id, revision: request!.revision }, verdict: "fulfilled" }] })).toBe("written");
        expect(await store.dated.get(request!.id)).toMatchObject({ state: "settled", closedReason: "answered" });
      });

      it("a message of the conversation still to be read holds what came after it", async () => {
        const { store, got, finish } = await setup();
        const a = await got({ date: NOW - 5000 });
        expect(await store.dated.marks.pendingOn(a.thread, NOW - 4000)).toBe(true);
        expect(await store.dated.marks.pendingOn(a.thread, NOW - 6000)).toBe(false);
        expect(await store.dated.marks.pendingOn(a.thread + 1000, NOW)).toBe(false);
        await finish(a.id, a.thread);
        expect(await store.dated.marks.pendingOn(a.thread, NOW)).toBe(false);
      });

      it("a closed request an open promise answers outlives the keep; one whose promise closed doesn't", async () => {
        const { store, request, reply, read, promise } = await talk();
        const r = await reply();
        await read(r, { rows: [promise()], verdicts: [{ request: { id: request.id, revision: request.revision }, verdict: "promise", item: 0 }] });
        await store.dated.update(request.id, request.revision, { state: "settled", closedReason: "settled", closedAt: NOW });
        const later = NOW + DATED_CLOSED_KEEP_MS + DAY;
        await store.dated.prune(later);
        expect(await store.dated.get(request.id)).not.toBeNull();
        const [p] = (await store.followups.ofThread(r.thread)).filter((x) => x.answers === request.id);
        await store.followups.update(p!.id, p!.revision, { state: "done", closedAt: NOW, closedReason: "user" });
        await store.dated.prune(later);
        expect(await store.dated.get(request.id)).toBeNull();
      });

      it("at the bound (1,001): a promise isn't added past it, the linked one stays linked; one retired frees its place", async () => {
        const { store, request, reply, read, promise } = await talk();
        const r = await reply();
        await read(r, { rows: Array.from({ length: FOLLOWUPS_ACTIVE_MAX }, (_, i) => promise({ item: 10 + i, dueAt: NOW + DAY + i })), verdicts: [{ request: { id: request.id, revision: request.revision }, verdict: "promise", item: 10 }] });
        const active = await store.followups.active();
        expect(active).toHaveLength(FOLLOWUPS_ACTIVE_MAX);
        const linked = active.find((p) => p.answers === request.id)!;
        expect(linked.item).toBe(10);
        const more = await reply();
        await read(more, { rows: [promise({ item: 0 })] });
        expect(await store.followups.active()).toHaveLength(FOLLOWUPS_ACTIVE_MAX);
        expect((await store.followups.ofThread(more.thread)).some((p) => p.messageId === more.id)).toBe(false);
        expect(await store.followups.get(linked.id)).toMatchObject({ answers: request.id, state: "open" });
        expect(await store.dated.get(request.id)).toMatchObject({ state: "open" });
        // one past its day retired (as `retire` does): the next promise has its place
        const last = active.at(-1)!;
        await store.followups.update(last.id, last.revision, { state: "dismissed", closedReason: "expired", closedAt: NOW });
        const next = await reply();
        await read(next, { rows: [promise({ item: 0 })] });
        expect(await store.followups.active()).toHaveLength(FOLLOWUPS_ACTIVE_MAX);
        expect((await store.followups.active()).some((p) => p.messageId === next.id)).toBe(true);
      });

      it("Codex code review: either verdict only at the revision the request was shown at; one put off meanwhile isn't linked nor settled", async () => {
        const { store, request, reply, read, promise } = await talk();
        const shown = { id: request.id, revision: request.revision };
        await store.dated.update(request.id, request.revision, { deferredUntil: NOW + DAY });
        const r = await reply();
        await read(r, { rows: [promise()], verdicts: [{ request: shown, verdict: "promise", item: 0 }] });
        expect((await store.followups.ofThread(r.thread)).find((p) => p.kind === "promise")!.answers).toBeNull();
        await store.followups.marks.queueScan([r.id], NOW);
        await read(r, { verdicts: [{ request: shown, verdict: "fulfilled" }] });
        expect(await store.dated.get(request.id)).toMatchObject({ state: "open", deferredUntil: NOW + DAY, revision: request.revision + 1 });
      });

      it("Codex code review: a reply read again at the bound keeps its rows and takes no wait's place", async () => {
        const { store, accountId, reply, read, promise } = await talk();
        // the oldest wait, on a conversation of its own
        const m = msg({ accountId, from: me, to: [shop], isSent: true, inInbox: false, gmailLabels: ["SENT"], subject: "Order", date: NOW - 50_000, providerMsgId: "wait-sent" });
        const waited = (await store.sync.ingest([m], { applyFilters: false, now: NOW, classifier: null, liveSent: { wanted: true } })).inserted[0]!;
        await read({ id: waited, thread: await threadOf(store, "wait-sent") }, { rows: [{ kind: "awaiting", item: AWAITING_ITEM, text: "a reply from the shop", quote: null, personName: "Shop", personEmail: shop.email, dueAt: NOW + 3 * DAY, dated: false }] });
        const wait = (await store.followups.active()).find((x) => x.kind === "awaiting")!;
        expect(wait).toBeDefined();
        const r = await reply();
        const rows = Array.from({ length: FOLLOWUPS_ACTIVE_MAX - 1 }, (_, i) => promise({ item: 10 + i, dueAt: NOW + DAY + i }));
        await read(r, { rows });
        expect(await store.followups.active()).toHaveLength(FOLLOWUPS_ACTIVE_MAX);
        // read again (a re-mark, as a request read late asks): the same rows, the wait kept
        await store.followups.marks.queueScan([r.id], NOW);
        expect(await read(r, { rows })).toBe("written");
        expect(await store.followups.get(wait.id)).toMatchObject({ state: "open" });
        expect(await store.followups.active()).toHaveLength(FOLLOWUPS_ACTIVE_MAX);
      });

      it("Codex code review: a promise made one item with its request by words before its verdict came is apart from it once linked, whichever was the canonical", async () => {
        // the promise the canonical: the request and its other reading leave it, the request theirs
        {
          const { store, got, item, finish, request, reply, read, promise } = await talk();
          const again = await got({ inReplyTo: "ask@v", references: ["ask@v"], date: NOW - 8500 });
          await finish(again.id, again.thread, { rows: [item({ kind: "respond", text: "Send the signed form" })] });
          const twin = (await store.dated.ofThread(again.thread)).find((x) => x.messageId === again.id)!;
          const r = await reply();
          await read(r, { rows: [promise()] });
          const p = (await store.followups.ofThread(r.thread)).find((x) => x.kind === "promise")!;
          expect(await store.today.link({ same: [{ item: { source: "dated", id: request.id }, sameAs: `promise:${p.id}` }, { item: { source: "dated", id: twin.id }, sameAs: `promise:${p.id}` }], details: [] })).toBe(2);
          await store.followups.marks.queueScan([r.id], NOW);
          await read(r, { rows: [promise()], verdicts: [{ request: { id: request.id, revision: request.revision }, verdict: "promise", item: 0 }] });
          expect(await store.followups.get(p.id)).toMatchObject({ answers: request.id, sameAs: null, revision: p.revision });
          expect(await store.dated.get(request.id)).toMatchObject({ sameAs: null, state: "open", revision: request.revision });
          expect((await store.dated.get(twin.id))!.sameAs).toBe(`dated:${request.id}`);
          const members = await store.today.members([`promise:${p.id}`]);
          expect([members.dated.map((x) => x.id), members.promises.map((x) => x.id)]).toEqual([[], [p.id]]);
        }
        // the request the canonical: the promise leaves it
        {
          const { store, request, reply, read, promise } = await talk();
          const r = await reply();
          await read(r, { rows: [promise()] });
          const p = (await store.followups.ofThread(r.thread)).find((x) => x.kind === "promise")!;
          expect(await store.today.link({ same: [{ item: { source: "promise", id: p.id }, sameAs: `dated:${request.id}` }], details: [] })).toBe(1);
          await store.followups.marks.queueScan([r.id], NOW);
          await read(r, { rows: [promise()], verdicts: [{ request: { id: request.id, revision: request.revision }, verdict: "promise", item: 0 }] });
          expect(await store.followups.get(p.id)).toMatchObject({ answers: request.id, sameAs: null });
          expect((await store.today.members([`dated:${request.id}`])).promises).toEqual([]);
        }
      });

      it("the code review's second round: the reply's other reading of the promise leaves the request's item with it and answers it too, whichever led", async () => {
        const twins = async (links: (ids: { scan: number; email: number; request: number }) => { item: { source: "dated" | "promise"; id: number }; sameAs: string }[]) => {
          const t = await talk();
          const r = await t.reply();
          const rows = [t.promise({ text: "scan the signed form", quote: "I'll scan the signed form" }), t.promise({ item: 1, text: "email the signed form", quote: "I'll scan the signed form and email it Wednesday" })];
          await t.read(r, { rows });
          const mine = await t.store.followups.ofThread(r.thread);
          const [scan, email] = [mine.find((x) => x.item === 0)!, mine.find((x) => x.item === 1)!];
          const same = links({ scan: scan.id, email: email.id, request: t.request.id });
          expect(await t.store.today.link({ same, details: [] })).toBe(same.length);
          await t.store.followups.marks.queueScan([r.id], NOW);
          await t.read(r, { rows, verdicts: [{ request: { id: t.request.id, revision: t.request.revision }, verdict: "promise", item: 1 }] });
          const now = { scan: (await t.store.followups.get(scan.id))!, email: (await t.store.followups.get(email.id))!, request: (await t.store.dated.get(t.request.id))! };
          expect([now.scan.answers, now.email.answers, now.scan.revision, now.email.revision]).toEqual([t.request.id, t.request.id, scan.revision, email.revision]);
          expect(now.request).toMatchObject({ sameAs: null, state: "open", revision: t.request.revision });
          expect((await t.store.today.members([`dated:${t.request.id}`])).promises).toEqual([]);
          return { ...now, ids: { scan: scan.id, email: email.id } };
        };
        // the review's case: the first reading leads the request's item, the linked one apart
        const a = await twins(({ scan, request }) => [{ item: { source: "dated", id: request }, sameAs: `promise:${scan}` }]);
        expect([a.scan.sameAs, a.email.sameAs]).toEqual([null, `promise:${a.ids.scan}`]);
        // both readings in it
        const b = await twins(({ scan, email, request }) => [{ item: { source: "dated", id: request }, sameAs: `promise:${scan}` }, { item: { source: "promise", id: email }, sameAs: `promise:${scan}` }]);
        expect([b.scan.sameAs, b.email.sameAs]).toEqual([null, `promise:${b.ids.scan}`]);
        // the request leads both: they leave it together, the linked one theirs
        const c = await twins(({ scan, email, request }) => [{ item: { source: "promise", id: scan }, sameAs: `dated:${request}` }, { item: { source: "promise", id: email }, sameAs: `dated:${request}` }]);
        expect([c.scan.sameAs, c.email.sameAs]).toEqual([`promise:${c.ids.email}`, null]);
      });
    });
  });
}
