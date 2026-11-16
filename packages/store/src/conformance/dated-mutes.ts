import { DATED_MUTES_MAX, type DatedMute } from "@terno/core";
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
}
