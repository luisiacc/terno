import { DATED_ACTIVE_MAX, DATED_CLOSED_KEEP_MS } from "@terno/core";
import { describe, expect, it } from "vitest";
import { DATED_MARK_MS, DATED_SCAN_MARK_MS, type DatedFinish, type DatedWrite } from "../dated";
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
          deferredUntil: null, arrivedAt: a.m.date, state: "open", closedReason: null, closedAt: null, fromScan: false, revision: 0, model: "m", provider: "p", createdAt: NOW,
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
        const { store, got, item, finish } = await setup();
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
      });
    });

    describe("reading and changing them", () => {
      it("a message you send answers the requests before it on its thread, not a bill nor a later request nor another thread's", async () => {
        const { store, accountId, got, item, finish } = await setup();
        const ask = await got({ rfcMessageId: "ask@x", date: NOW - 5000 });
        await finish(ask.id, ask.thread, { rows: [item({ kind: "respond", text: "Send the deck" }), item({ kind: "pay", item: 1, dueDay: "2026-11-21" })] });
        const elsewhere = await got({ date: NOW - 4000 });
        await finish(elsewhere.id, elsewhere.thread, { rows: [item({ kind: "respond", text: "Answer Tom" })] });
        // your reply on the first thread, from elsewhere (sync)
        await store.sync.ingest([msg({ accountId, from: me, to: [bank], isSent: true, inInbox: false, inReplyTo: "ask@x", references: ["ask@x"], subject: "Re", date: NOW - 3000 })], { applyFilters: false, now: NOW, classifier: null });
        const open = await store.dated.active();
        expect(open.map((r) => [r.threadId, r.kind]).sort()).toEqual([[ask.thread, "pay"], [elsewhere.thread, "respond"]].sort());
        const answered = (await store.dated.ofThread(ask.thread)).find((r) => r.kind === "respond");
        expect(answered).toBeUndefined();
        // a request read after your reply is stored answered (the reader finishing late, or the 14-day check)
        const late = await got({ inReplyTo: "ask@x", references: ["ask@x"], date: NOW - 3500 });
        await finish(late.id, late.thread, { rows: [item({ kind: "respond", text: "Send the deck too" })] });
        expect((await store.dated.ofThread(ask.thread)).some((r) => r.kind === "respond")).toBe(false);
      });

      it("Codex code review of the fixes: a forged From claiming your address, in the Inbox, answers nothing", async () => {
        const { store, accountId, got, item, finish } = await setup();
        const ask = await got({ rfcMessageId: "ask2@x", date: NOW - 5000 });
        await finish(ask.id, ask.thread, { rows: [item({ kind: "respond", text: "Send the deck" })] });
        // what IMAP marks sent because its From is yours, though it arrived in the Inbox
        await store.sync.ingest([msg({ accountId, from: me, to: [bank], isSent: true, inInbox: true, inReplyTo: "ask2@x", references: ["ask2@x"], subject: "Re", date: NOW - 3000 })], { applyFilters: false, now: NOW, classifier: null });
        expect((await store.dated.ofThread(ask.thread)).map((r) => r.kind)).toEqual(["respond"]);
        // Gmail's SENT label is yours for certain, in the Inbox or not (a reply to yourself too)
        await store.sync.ingest([msg({ accountId, from: me, to: [bank], isSent: true, inInbox: true, gmailLabels: ["SENT", "INBOX"], inReplyTo: "ask2@x", references: ["ask2@x"], subject: "Re", date: NOW - 2000 })], { applyFilters: false, now: NOW, classifier: null });
        expect(await store.dated.ofThread(ask.thread)).toEqual([]);
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
  });
}
