import { DATED_MUTE_PAIRS_MAX, DATED_MUTES_MAX, type DatedMute } from "@terno/core";
import { describe, expect, it } from "vitest";
import { DATED_NOTHING_ASKED_SINCE, type DatedFinish, type DatedWrite } from "../dated";
import type { MailStore } from "../mail-store";
import type { IncomingMessage } from "../types";
import { msg, threadOf, withAccounts } from "./fixtures";

const NOW = Date.UTC(2026, 10, 15, 12);
const DAY = 86_400_000;
const me = { name: "Me", email: "me0@example.com" };
const shop = { name: "Shop", email: "Orders+eu@Shop.test" };
const ana = { name: "Ana", email: "ana@people.test" };

/**
 * Plan 210 (iteration 4, the Codex review's revision 2): the senders and kinds muted in What matters, a store-owned table:
 * normalized keys, bounded and never evicting, read by the reader's own commit (a muted sender's reading keeps nothing, a
 * muted kind's new items aren't added while its settlements and moves are) and by Needs you's walk (a muted sender's
 * conversations leave it with nothing recorded, and come back on Unmute). The same in both stores.
 */
export function defineDatedMutesConformance(fresh: () => Promise<MailStore>, reopen: (store: MailStore) => Promise<MailStore>): void {
  describe("Muted senders and kinds (plan 210, iteration 4)", () => {
    async function setup() {
      const store = await fresh();
      const [accountId] = await withAccounts(store, 1);
      const got = async (over: Partial<IncomingMessage> = {}) => {
        const m = msg({ accountId: accountId!, from: shop, to: [me], date: NOW - 60_000, listId: null, ...over });
        const r = await store.sync.ingest([m], { applyFilters: false, now: NOW, classifier: null, datedMail: { since: null } });
        return { id: r.inserted[0]!, thread: await threadOf(store, m.providerMsgId!) };
      };
      const item = (over: Partial<DatedWrite> = {}): DatedWrite => ({ kind: "delivery", item: 0, text: "Package arrives", quote: "arrives Friday", dueDay: "2026-11-20", dueAt: NOW + 5 * DAY, timed: false, dated: true, actAt: NOW + 5 * DAY, ...over });
      const finish = (messageId: number, threadId: number, over: Partial<DatedFinish> = {}) =>
        store.dated.finish({ messageId, threadId, fromScan: false, rows: [], settled: [], now: NOW, model: "m", provider: "p", promptVersion: DATED_NOTHING_ASKED_SINCE, clearGeneration: store.dated.clearGeneration(), ...over });
      const mute = (on: DatedMute["on"], key: string, at = NOW, name = "") => store.dated.mutes.add({ on, key, name, at });
      return { store, accountId: accountId!, got, item, finish, mute };
    }

    it("keeps senders by their normalized address and kinds by name, newest first, across a reopen; refuses anything else", async () => {
      const { store, mute } = await setup();
      expect(await mute("sender", " Orders+EU@Shop.test ", NOW, "  Shop  ")).toBe("added");
      expect(await mute("kind", "delivery", NOW + 1)).toBe("added");
      // the same sender by another spelling, the same kind: there already
      expect(await mute("sender", "orders@shop.test", NOW + 2)).toBe("already");
      expect(await mute("kind", "delivery", NOW + 3)).toBe("already");
      // a kind's name is never kept, nor anything that isn't an address or one of ours
      await expect(mute("kind", "newsletter")).rejects.toThrow();
      await expect(mute("sender", "not an address")).rejects.toThrow();
      expect(await store.dated.mutes.list()).toEqual([
        { on: "kind", key: "delivery", name: "", at: NOW + 1 },
        { on: "sender", key: "orders@shop.test", name: "Shop", at: NOW },
      ]);
      const again = await reopen(store);
      expect((await again.dated.mutes.list()).map((m) => m.key)).toEqual(["delivery", "orders@shop.test"]);
      // Clear AI data keeps them: they're the reader's choice, not what AI read
      await again.dated.clear();
      expect(await again.dated.mutes.list()).toHaveLength(2);
      expect(await again.dated.mutes.remove("sender", "ORDERS+x@shop.test")).toEqual({ on: "sender", key: "orders@shop.test", name: "Shop", at: NOW });
      expect(await again.dated.mutes.remove("sender", "orders@shop.test")).toBeNull();
      expect(await again.dated.mutes.remove("kind", "newsletter")).toBeNull();
      expect((await again.dated.mutes.list()).map((m) => m.key)).toEqual(["delivery"]);
    });

    it("is bounded: at the most it keeps, another is refused and none is dropped for it", async () => {
      const { store, mute } = await setup();
      for (let i = 0; i < DATED_MUTES_MAX; i++) expect(await mute("sender", `s${i}@shop.test`, NOW + i)).toBe("added");
      expect(await mute("kind", "pay", NOW + DATED_MUTES_MAX)).toBe("full");
      expect(await mute("sender", "s0@shop.test", NOW + DATED_MUTES_MAX)).toBe("already");
      const list = await store.dated.mutes.list();
      expect(list).toHaveLength(DATED_MUTES_MAX);
      expect(list.at(-1)!.key).toBe("s0@shop.test");
      await store.dated.mutes.remove("sender", "s7@shop.test");
      expect(await mute("kind", "pay", NOW + DATED_MUTES_MAX)).toBe("added");
    });

    it("a reading of a sender muted meanwhile keeps nothing: no item, settlement or move, and its mark is consumed", async () => {
      const { store, got, item, finish, mute } = await setup();
      const first = await got({ providerMsgId: "first" });
      expect(await finish(first.id, first.thread, { rows: [item()] })).toBe("written");
      const [open] = await store.dated.active();
      const next = await got({ providerMsgId: "next", date: NOW - 30_000, providerThreadId: "other" });
      await mute("sender", shop.email);
      expect(await finish(next.id, next.thread, { rows: [item({ kind: "pay", text: "Pay the order" })], settled: [{ id: open!.id, revision: open!.revision }], moved: [{ id: open!.id, dueDay: "2026-11-21", dueAt: NOW + 6 * DAY, timed: false, actAt: NOW + 6 * DAY }] })).toBe("gone");
      expect(await store.dated.marks.page(null, 10)).toEqual([]);
      // the open item is as it was: hidden by the feed while muted, never closed or moved here
      expect(await store.dated.active()).toEqual([open]);
    });

    it("a muted kind's new items aren't stored; its settlements, moves and other kinds are", async () => {
      const { store, got, item, finish, mute } = await setup();
      const order = await got({ providerMsgId: "order", providerThreadId: "order" });
      expect(await finish(order.id, order.thread, { rows: [item()] })).toBe("written");
      const [parcel] = await store.dated.active();
      await mute("kind", "delivery");
      const update = await got({ providerMsgId: "update", date: NOW - 30_000, providerThreadId: "order" });
      expect(await finish(update.id, update.thread, { rows: [item({ item: 0, text: "Second package arrives" }), item({ item: 1, kind: "pay", text: "Pay the balance", dueDay: "2026-11-22", actAt: NOW + 7 * DAY })], moved: [{ id: parcel!.id, dueDay: "2026-11-21", dueAt: NOW + 6 * DAY, timed: false, actAt: NOW + 6 * DAY }] })).toBe("written");
      const open = await store.dated.active();
      expect(open.map((r) => [r.kind, r.text, r.dueDay])).toEqual([["delivery", "Package arrives", "2026-11-21"], ["pay", "Pay the balance", "2026-11-22"]]);
      const done = await got({ providerMsgId: "delivered", date: NOW - 10_000, providerThreadId: "order" });
      expect(await finish(done.id, done.thread, { settled: [{ id: parcel!.id, revision: open[0]!.revision }] })).toBe("written");
      expect((await store.dated.get(parcel!.id))!.state).toBe("settled");
    });

    it("a muted sender's conversations aren't waiting on you, nothing recorded for them; Unmute brings them back", async () => {
      const { store, accountId, got, mute } = await setup();
      // a conversation you're in: yours, then Ana's answer
      await store.sync.ingest([msg({ accountId, providerMsgId: "out", providerThreadId: "talk", from: me, to: [ana], isSent: true, isRead: true, subject: "Lunch", date: NOW - 5000, listId: null })], { applyFilters: false, now: NOW, classifier: null });
      const answer = await got({ providerMsgId: "in", providerThreadId: "talk", from: ana, subject: "Re: Lunch", inReplyTo: "out", date: NOW - 1000 });
      expect(await store.today.waitingAmong([answer.thread], NOW)).toEqual([answer.thread]);
      expect(await mute("sender", "ANA@people.test")).toBe("added");
      expect(await store.today.waitingAmong([answer.thread], NOW)).toEqual([]);
      expect(await store.today.waitingPage({ now: NOW, after: null, limit: 10 })).toEqual([]);
      expect(await store.today.needsCount(NOW)).toBe(0);
      // a reading meanwhile is refused (the reader's own commit), so nothing says it asked nothing
      expect(await store.dated.finish({ messageId: answer.id, threadId: answer.thread, fromScan: false, rows: [], settled: [], now: NOW, model: "m", provider: "p", promptVersion: DATED_NOTHING_ASKED_SINCE, nothingAsked: true, clearGeneration: store.dated.clearGeneration() })).toBe("gone");
      await store.dated.mutes.remove("sender", ana.email);
      expect(await store.today.waitingAmong([answer.thread], NOW)).toEqual([answer.thread]);
      expect(await store.today.needsCount(NOW)).toBe(1);
    });
  });

  /**
   * Iteration 5 (the owner's narrow offer; the Codex review's revision 2): a kind muted from one sender is an identity of
   * its own (`pairKey`), kept in a companion table with its own bound, beside v69's senders and kinds.
   */
  describe("A kind muted from one sender (plan 210, iteration 5)", () => {
    async function setup() {
      const store = await fresh();
      const [accountId] = await withAccounts(store, 1);
      const got = async (over: Partial<IncomingMessage> = {}) => {
        const m = msg({ accountId: accountId!, from: shop, to: [me], date: NOW - 60_000, listId: null, ...over });
        const r = await store.sync.ingest([m], { applyFilters: false, now: NOW, classifier: null, datedMail: { since: null } });
        return { id: r.inserted[0]!, thread: await threadOf(store, m.providerMsgId!) };
      };
      const item = (over: Partial<DatedWrite> = {}): DatedWrite => ({ kind: "delivery", item: 0, text: "Package arrives", quote: "arrives Friday", dueDay: "2026-11-20", dueAt: NOW + 5 * DAY, timed: false, dated: true, actAt: NOW + 5 * DAY, ...over });
      const finish = (messageId: number, threadId: number, over: Partial<DatedFinish> = {}) =>
        store.dated.finish({ messageId, threadId, fromScan: false, rows: [], settled: [], now: NOW, model: "m", provider: "p", promptVersion: DATED_NOTHING_ASKED_SINCE, clearGeneration: store.dated.clearGeneration(), ...over });
      const pair = (key: string, at = NOW, name = "") => store.dated.mutes.add({ on: "pair", key, name, at });
      return { store, accountId: accountId!, got, item, finish, pair };
    }

    it("keeps a pair by its normalized kind and sender, listed with the others newest first across a reopen; refuses a half pair", async () => {
      const { store, pair } = await setup();
      expect(await store.dated.mutes.add({ on: "sender", key: "ana@people.test", name: "Ana", at: NOW })).toBe("added");
      expect(await pair(" delivery| Orders+EU@Shop.test ", NOW + 1, "  Shop  ")).toBe("added");
      // the same pair by another spelling: there already; another kind from the same sender: its own
      expect(await pair("delivery|orders@shop.test", NOW + 2)).toBe("already");
      expect(await pair("pay|orders@shop.test", NOW + 1, "Shop")).toBe("added");
      await expect(pair("newsletter|orders@shop.test")).rejects.toThrow();
      await expect(pair("delivery|not an address")).rejects.toThrow();
      await expect(pair("orders@shop.test")).rejects.toThrow();
      const all = [
        { on: "pair", key: "delivery|orders@shop.test", name: "Shop", at: NOW + 1 },
        { on: "pair", key: "pay|orders@shop.test", name: "Shop", at: NOW + 1 },
        { on: "sender", key: "ana@people.test", name: "Ana", at: NOW },
      ];
      expect(await store.dated.mutes.list()).toEqual(all);
      const again = await reopen(store);
      expect(await again.dated.mutes.list()).toEqual(all);
      // a pair is never the sender alone, nor its kind
      expect(await again.dated.mutes.remove("sender", "orders@shop.test")).toBeNull();
      expect(await again.dated.mutes.remove("kind", "delivery")).toBeNull();
      await again.dated.clear();
      expect(await again.dated.mutes.remove("pair", "DELIVERY|orders+x@shop.test")).toBeNull();
      expect(await again.dated.mutes.remove("pair", "delivery|ORDERS+x@shop.test")).toEqual(all[0]);
      expect(await again.dated.mutes.remove("pair", "delivery|orders@shop.test")).toBeNull();
      expect((await again.dated.mutes.list()).map((m) => m.key)).toEqual(["pay|orders@shop.test", "ana@people.test"]);
    });

    it("pairs have their own bound: refused at it, none dropped, the senders' and kinds' bound apart", async () => {
      const { store, pair } = await setup();
      for (let i = 0; i < DATED_MUTE_PAIRS_MAX; i++) expect(await pair(`delivery|s${i}@shop.test`, NOW + i)).toBe("added");
      expect(await pair("pay|s0@shop.test")).toBe("full");
      expect(await pair("delivery|s0@shop.test")).toBe("already");
      expect(await store.dated.mutes.add({ on: "kind", key: "pay", name: "", at: NOW })).toBe("added");
      expect(await store.dated.mutes.list()).toHaveLength(DATED_MUTE_PAIRS_MAX + 1);
      await store.dated.mutes.remove("pair", "delivery|s7@shop.test");
      expect(await pair("pay|s0@shop.test")).toBe("added");
    });

    it("two kinds from one sender: only the muted kind's new items aren't stored; its settlement and move, their other kind and another sender's go through", async () => {
      const { store, got, item, finish, pair } = await setup();
      const order = await got({ providerMsgId: "order", providerThreadId: "order" });
      expect(await finish(order.id, order.thread, { rows: [item()] })).toBe("written");
      const [parcel] = await store.dated.active();
      expect(await pair(`delivery|${shop.email}`)).toBe("added");
      const update = await got({ providerMsgId: "update", date: NOW - 30_000, providerThreadId: "order" });
      expect(await finish(update.id, update.thread, { rows: [item({ item: 0, text: "Second package arrives" }), item({ item: 1, kind: "pay", text: "Pay the balance", dueDay: "2026-11-22", actAt: NOW + 7 * DAY })], moved: [{ id: parcel!.id, dueDay: "2026-11-21", dueAt: NOW + 6 * DAY, timed: false, actAt: NOW + 6 * DAY }] })).toBe("written");
      // the existing delivery is kept (the feed hides it, never the store), moved; the pay kept
      expect((await store.dated.active()).map((r) => [r.kind, r.text, r.dueDay])).toEqual([["delivery", "Package arrives", "2026-11-21"], ["pay", "Pay the balance", "2026-11-22"]]);
      // another sender's delivery is theirs
      const other = await got({ providerMsgId: "other", providerThreadId: "other", from: { name: "Post", email: "post@post.test" }, date: NOW - 20_000 });
      expect(await finish(other.id, other.thread, { rows: [item({ text: "Letter arrives" })] })).toBe("written");
      expect((await store.dated.active()).filter((r) => r.kind === "delivery").map((r) => r.text)).toEqual(["Letter arrives", "Package arrives"]);
      // a settlement through the pair
      const done = await got({ providerMsgId: "delivered", date: NOW - 10_000, providerThreadId: "order" });
      const now = (await store.dated.get(parcel!.id))!;
      expect(await finish(done.id, done.thread, { settled: [{ id: parcel!.id, revision: now.revision }] })).toBe("written");
      expect((await store.dated.get(parcel!.id))!.state).toBe("settled");
    });

    it("a pair never silences its sender: their reading is kept, their conversations stay waiting on you, and nothing asked is recorded as ever", async () => {
      const { store, accountId, got, item, finish, pair } = await setup();
      await store.sync.ingest([msg({ accountId, providerMsgId: "out", providerThreadId: "talk", from: me, to: [ana], isSent: true, isRead: true, subject: "Lunch", date: NOW - 5000, listId: null })], { applyFilters: false, now: NOW, classifier: null });
      const answer = await got({ providerMsgId: "in", providerThreadId: "talk", from: ana, subject: "Re: Lunch", inReplyTo: "out", date: NOW - 1000 });
      expect(await pair(`respond|${ana.email}`)).toBe("added");
      expect(await pair(`event|${ana.email}`)).toBe("added");
      expect(await store.today.waitingAmong([answer.thread], NOW)).toEqual([answer.thread]);
      expect(await store.today.needsCount(NOW)).toBe(1);
      // a reading of hers: the muted kinds aren't added, the reading is kept (no "gone") and its mark consumed
      expect(await finish(answer.id, answer.thread, { rows: [item({ kind: "respond", text: "Answer Ana", quote: "let me know" }), item({ item: 1, kind: "event", text: "Lunch", quote: "lunch Friday" })] })).toBe("written");
      expect(await store.dated.active()).toEqual([]);
      expect(await store.dated.marks.page(null, 10)).toEqual([]);
      expect(await store.today.waitingAmong([answer.thread], NOW)).toEqual([answer.thread]);
    });

    it("says who's written to, by key, once a sent message reaches them (what an offer and taking it both check)", async () => {
      const { store, accountId } = await setup();
      const parcelo = { name: "Parcelo", email: "Track@Parcelo.test" };
      expect(await store.dated.written(["track@parcelo.test", "ana@people.test"])).toEqual(new Set());
      await store.sync.ingest([msg({ accountId, providerMsgId: "out", providerThreadId: "q", from: me, to: [parcelo], isSent: true, isRead: true, subject: "Where is it?", date: NOW - 5000, listId: null })], { applyFilters: false, now: NOW, classifier: null });
      expect(await store.dated.written(["track@parcelo.test", "ana@people.test"])).toEqual(new Set(["track@parcelo.test"]));
    });
  });
}
