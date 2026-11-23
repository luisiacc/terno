import { NO_PREFERENCES, type PreferenceVerdict, type WhatMattersPreferences } from "@terno/core";
import { describe, expect, it } from "vitest";
import type { MailStore } from "../mail-store";
import type { IncomingMessage } from "../types";
import { WANTED_CLOSED_KEEP_MS, WANTED_LOOK_MARK_MS, WANTED_MARK_MS, WANTED_OPEN_MAX, WANTED_ORPHAN_KEEP_MS, type WantedFinish, type WantedWrite } from "../what-matters";
import { msg, threadOf, withAccounts } from "./fixtures";

const NOW = Date.UTC(2026, 10, 23, 12);
const DAY = 86_400_000;
const me = { name: "Me", email: "me0@example.com" };
const gym = { name: "Gym", email: "hello@gym.test" };

/**
 * Plan 248: What matters in the user's words. The record is written by a compare-and-swap on its revision, and every
 * worker's write (a verdict, the second reader's finish) is refused in its own unit when the record has moved on; the wanted
 * items are apart from the dated ones (their own bound, their own Clear), follow their thread through a merge and go with
 * it; a mark is only ever for received mail. The same in both stores.
 */
export function defineWhatMattersConformance(fresh: () => Promise<MailStore>, reopen: (store: MailStore) => Promise<MailStore>): void {
  describe("What matters in your words (plan 248)", () => {
    const words = (text: string): Omit<WhatMattersPreferences, "revision"> => ({ text, rules: [], notes: [], compiledWith: { version: 1, provider: "p", model: "m" }, savedAt: NOW, language: "en" });
    const row = (over: Partial<WantedWrite> = {}): WantedWrite => ({ kind: "renew", text: "Renew the gym", quote: "renews on November 30", dueDay: "2026-11-30", dueAt: NOW + 7 * DAY, timed: false, dated: true, actAt: NOW + 4 * DAY, rules: ["s1"], ...over });

    async function setup() {
      const store = await fresh();
      const [accountId, other] = await withAccounts(store, 2);
      const wm = store.whatMatters;
      const got = async (over: Partial<IncomingMessage> = {}) => {
        const m = msg({ accountId: accountId!, from: gym, to: [me], date: NOW - 60_000, ...over });
        const r = await store.sync.ingest([m], { applyFilters: false, now: NOW, classifier: null });
        return { id: r.inserted[0]!, thread: await threadOf(store, m.providerMsgId!), m };
      };
      const mark = (x: { id: number; thread: number; m: IncomingMessage }, source: "live" | "look" = "live", now = NOW) => wm.wanted.marks.add({ messageId: x.id, threadId: x.thread, arrivedAt: x.m.date, source }, now);
      const finish = (x: { id: number; thread: number; m: IncomingMessage }, rows: WantedWrite[], over: Partial<WantedFinish> = {}) =>
        wm.wanted.finish({ messageId: x.id, threadId: x.thread, senderKey: "hello@gym.test", arrivedAt: x.m.date, rows, now: NOW, model: "m", provider: "p", promptVersion: 1, fromLook: false, revision: 0, ...over });
      /** a message read by the second reader: marked, then finished with these rows */
      const wanted = async (rows: WantedWrite[], over: Partial<IncomingMessage> = {}) => {
        const x = await got(over);
        expect(await mark(x)).toBe(true);
        expect(await finish(x, rows)).toBe("written");
        return x;
      };
      const marked = async () => (await wm.wanted.marks.page(100)).map((m) => m.messageId);
      return { store, wm, accountId: accountId!, other: other!, got, mark, finish, wanted, marked };
    }

    describe("the record", () => {
      it("is empty until saved; a save is a compare-and-swap on its revision, kept through a reopen", async () => {
        const { store, wm } = await setup();
        expect(await wm.preferences.get()).toEqual(NO_PREFERENCES);
        const first = await wm.preferences.save(words("Show me gym renewals"), 0);
        expect(first).toEqual({ ...words("Show me gym renewals"), revision: 1 });
        // another window saved from the same start: refused, the stored words untouched
        expect(await wm.preferences.save(words("Hide receipts"), 0)).toBeNull();
        expect(await wm.preferences.save(words("Hide receipts"), 2)).toBeNull();
        expect(await wm.preferences.get()).toEqual(first);
        const again = await reopen(store);
        expect(await again.whatMatters.preferences.get()).toEqual(first);
        // Clear is a save of the empty box: the revision still moves
        expect(await again.whatMatters.preferences.save(words(""), 1)).toMatchObject({ text: "", revision: 2 });
        expect((await again.whatMatters.preferences.get()).revision).toBe(2);
      });

      it("the draft is its own value: an older seq is refused, and it never touches the saved words", async () => {
        const { store, wm } = await setup();
        expect(await wm.preferences.draft.get()).toBeNull();
        await wm.preferences.save(words("Saved"), 0);
        expect(await wm.preferences.draft.put({ text: "typing more", seq: 5 })).toBe(true);
        // a late debounced write
        expect(await wm.preferences.draft.put({ text: "typing", seq: 4 })).toBe(false);
        expect(await wm.preferences.draft.get()).toEqual({ text: "typing more", seq: 5 });
        expect(await wm.preferences.draft.put({ text: "typing more still", seq: 6 })).toBe(true);
        const again = await reopen(store);
        expect(await again.whatMatters.preferences.draft.get()).toEqual({ text: "typing more still", seq: 6 });
        expect(await again.whatMatters.preferences.get()).toMatchObject({ text: "Saved", revision: 1 });
      });
    });

    describe("verdicts", () => {
      const verdict = (target: string, over: Partial<PreferenceVerdict & { failed: boolean }> = {}) => ({ target, basis: "b", rules: ["h1"], at: NOW, ...over });

      it("are written only at the record's revision, read by target, replaced by a newer one, and kept through a reopen", async () => {
        const { store, wm } = await setup();
        expect(await wm.verdicts.put([verdict("d:1:0"), verdict("d:2:3", { rules: [], failed: true }), verdict("w:9:1", { rules: ["h1", "h2"] })], 0)).toBe(true);
        expect(await wm.verdicts.get([])).toEqual(new Map());
        expect(await wm.verdicts.get(["d:1:0", "d:1:0", "d:2:3", "nope"])).toEqual(
          new Map([
            ["d:1:0", { target: "d:1:0", basis: "b", rules: ["h1"], at: NOW, failed: false }],
            ["d:2:3", { target: "d:2:3", basis: "b", rules: [], at: NOW, failed: true }],
          ]),
        );
        // the words were saved while a classifier ran: its verdicts are for words that are gone, and none is written
        await wm.preferences.save(words("Hide receipts"), 0);
        expect(await wm.verdicts.put([verdict("d:1:0", { rules: [], at: NOW + 1 }), verdict("d:7:0")], 0)).toBe(false);
        expect(await wm.verdicts.get(["d:1:0", "d:7:0"])).toEqual(new Map([["d:1:0", { target: "d:1:0", basis: "b", rules: ["h1"], at: NOW, failed: false }]]));
        expect(await wm.verdicts.put([verdict("d:1:0", { basis: "b2", rules: [], at: NOW + 1 })], 1)).toBe(true);
        const again = await reopen(store);
        expect(await again.whatMatters.verdicts.get(["d:1:0", "w:9:1"])).toEqual(
          new Map([
            ["d:1:0", { target: "d:1:0", basis: "b2", rules: [], at: NOW + 1, failed: false }],
            ["w:9:1", { target: "w:9:1", basis: "b", rules: ["h1", "h2"], at: NOW, failed: false }],
          ]),
        );
        await again.whatMatters.verdicts.clear();
        expect(await again.whatMatters.verdicts.get(["d:1:0", "d:2:3", "w:9:1"])).toEqual(new Map());
        // Clear keeps the words
        expect((await again.whatMatters.preferences.get()).text).toBe("Hide receipts");
      });

      it("prune to the bound: another basis's first, oldest first, then this one's oldest that aren't kept", async () => {
        const { wm } = await setup();
        const all = ["t1", "t2", "t3", "t4", "o1", "o2"];
        const left = async () => [...(await wm.verdicts.get(all)).keys()].sort();
        // the other basis's are the newest: they still go first
        await wm.verdicts.put([verdict("t1", { at: 1 }), verdict("t2", { at: 2 }), verdict("t3", { at: 3 }), verdict("t4", { at: 4 }), verdict("o1", { basis: "old", at: 6 }), verdict("o2", { basis: "old", at: 5 })], 0);
        expect(await wm.verdicts.prune("b", new Set(), 6)).toBe(0);
        expect(await wm.verdicts.prune("b", new Set(), 5)).toBe(1);
        expect(await left()).toEqual(["o1", "t1", "t2", "t3", "t4"]);
        // two over: the other basis's last one, then the oldest not on screen
        expect(await wm.verdicts.prune("b", new Set(["t1"]), 3)).toBe(2);
        expect(await left()).toEqual(["t1", "t3", "t4"]);
        // what's kept is never taken, whatever the bound
        expect(await wm.verdicts.prune("b", new Set(["t1", "t3", "t4"]), 1)).toBe(0);
        expect(await wm.verdicts.prune("b", new Set(["t4"]), 1)).toBe(2);
        expect(await left()).toEqual(["t4"]);
      });
    });

    describe("the marks", () => {
      it("are for received mail only, once per message", async () => {
        const { wm, accountId, got, mark, marked } = await setup();
        const a = await got();
        expect(await mark(a)).toBe(true);
        expect(await mark(a, "look")).toBe(false);
        const variants: Partial<IncomingMessage>[] = [{ isSent: true, from: me, to: [gym], inInbox: false }, { isSpam: true }, { isTrash: true }, { isDraft: true }, { from: me }];
        for (const over of variants) expect(await mark(await got({ accountId, ...over }))).toBe(false);
        expect(await wm.wanted.marks.add({ messageId: 999_999, threadId: a.thread, arrivedAt: NOW, source: "live" }, NOW)).toBe(false);
        expect(await marked()).toEqual([a.id]);
        expect(await wm.wanted.marks.page(1)).toEqual([{ messageId: a.id, threadId: a.thread, arrivedAt: a.m.date, queuedAt: NOW, source: "live" }]);
      });

      it("page live before the look back, newest first; count, consume and the look back's own clear, through a reopen", async () => {
        const { store, got, mark } = await setup();
        const l1 = await got({ date: NOW - 4000 });
        const l2 = await got({ date: NOW - 2000 });
        const k1 = await got({ date: NOW - 1000 });
        const k2 = await got({ date: NOW - 3000 });
        await mark(k2, "look");
        await mark(l1);
        await mark(k1, "look");
        await mark(l2);
        const again = await reopen(store);
        const marks = again.whatMatters.wanted.marks;
        const page = async (n: number) => (await marks.page(n)).map((m) => m.messageId);
        expect(await page(10)).toEqual([l2.id, l1.id, k1.id, k2.id]);
        expect(await page(3)).toEqual([l2.id, l1.id, k1.id]);
        expect([await marks.count(), await marks.count("live"), await marks.count("look")]).toEqual([4, 2, 2]);
        await marks.consume(l2.id);
        await marks.consume(l2.id);
        expect(await page(10)).toEqual([l1.id, k1.id, k2.id]);
        await marks.clearLook();
        expect(await page(10)).toEqual([l1.id]);
        expect([await marks.count(), await marks.count("live"), await marks.count("look")]).toEqual([1, 1, 0]);
      });

      it("prune by how long each has waited: a live one sooner than the look back's", async () => {
        const { wm, got, mark, marked } = await setup();
        const live = await got({ date: NOW - 2000 });
        const look = await got({ date: NOW - 1000 });
        const later = await got({ date: NOW - 3000 });
        await mark(live);
        await mark(look, "look");
        await mark(later, "live", NOW + 1000);
        expect(await wm.wanted.marks.prune(NOW + WANTED_MARK_MS)).toBe(0);
        expect(await wm.wanted.marks.prune(NOW + WANTED_MARK_MS + 1)).toBe(1);
        expect(await marked()).toEqual([later.id, look.id]);
        expect(await wm.wanted.marks.prune(NOW + WANTED_LOOK_MARK_MS)).toBe(1);
        expect(await wm.wanted.marks.prune(NOW + WANTED_LOOK_MARK_MS + 1)).toBe(1);
        expect(await marked()).toEqual([]);
      });
    });

    describe("the second reader's finish", () => {
      it("writes the rows and takes the mark; without one there's nothing to finish", async () => {
        const { store, wm, got, mark, finish } = await setup();
        const a = await got();
        // never marked (or cleared since): nothing is kept
        expect(await finish(a, [row()])).toBe("gone");
        expect(await wm.wanted.active()).toEqual([]);
        await mark(a);
        expect(await finish(a, [row(), row({ kind: "pay", text: "Pay the gym", quote: "pay by November 25", dueDay: "2026-11-25", dueAt: NOW + 2 * DAY, timed: true, dated: false, actAt: NOW + DAY, rules: ["s2", "s2", "s1"] })], { fromLook: true, promptVersion: 3 })).toBe("written");
        expect(await wm.wanted.marks.count()).toBe(0);
        const rows = await wm.wanted.active();
        // by when to act
        expect(rows.map((r) => r.kind)).toEqual(["pay", "renew"]);
        expect(rows[1]).toEqual({
          id: rows[1]!.id, threadId: a.thread, messageId: a.id, kind: "renew", text: "Renew the gym", quote: "renews on November 30", senderKey: "hello@gym.test", dueDay: "2026-11-30", dueAt: NOW + 7 * DAY, timed: false, dated: true, actAt: NOW + 4 * DAY,
          deferredUntil: null, arrivedAt: a.m.date, state: "open", closedReason: null, closedAt: null, rules: ["s1"], orphanedAt: null, fromLook: true, revision: 0, model: "m", provider: "p", promptVersion: 3, createdAt: NOW,
        });
        expect(rows[0]).toMatchObject({ timed: true, dated: false, rules: ["s2", "s1"] });
        // taken already
        expect(await finish(a, [row({ quote: "another" })])).toBe("gone");
        const again = await reopen(store);
        expect(await again.whatMatters.wanted.active()).toEqual(rows);
        expect(await again.whatMatters.wanted.get(rows[0]!.id)).toEqual(rows[0]);
        expect(await again.whatMatters.wanted.get(999_999)).toBeNull();
        expect(await again.whatMatters.wanted.ofThread(a.thread)).toEqual(rows);
        expect(await again.whatMatters.wanted.ofThread(a.thread + 999)).toEqual([]);
      });

      it("the same item twice (message, kind, day and quote) is one, wanted by both rules; two quotes on one day stay two", async () => {
        const { wm, got, mark, finish } = await setup();
        const a = await got();
        await mark(a);
        // in one reading: the quote compared whatever its spacing and case
        expect(await finish(a, [row(), row({ quote: "  Renews  on\nNOVEMBER 30 ", text: "Another wording", rules: ["s2"] }), row({ quote: "your locker renews on November 30" })])).toBe("written");
        let rows = await wm.wanted.active();
        expect(rows.map((r) => [r.quote, r.rules, r.text])).toEqual([["renews on November 30", ["s1", "s2"], "Renew the gym"], ["your locker renews on November 30", ["s1"], "Renew the gym"]]);
        // in a later one: another rule, the same item; another kind or day is its own
        await mark(a);
        expect(await finish(a, [row({ rules: ["s3", "s1"] }), row({ kind: "pay" }), row({ dueDay: "2026-12-01" })])).toBe("written");
        rows = await wm.wanted.active();
        expect(rows).toHaveLength(4);
        expect(rows.find((r) => r.quote === "renews on November 30" && r.kind === "renew" && r.dueDay === "2026-11-30")!.rules).toEqual(["s1", "s2", "s3"]);
        // another message's same words are its own item
        const b = await got();
        await mark(b);
        await finish(b, [row()]);
        expect(await wm.wanted.active()).toHaveLength(5);
      });

      it("a reading that began before the words moved keeps nothing, and its mark stays for the next pass", async () => {
        const { wm, got, mark, finish } = await setup();
        const a = await got();
        await mark(a);
        await wm.preferences.save(words("Show me gym renewals"), 0);
        expect(await finish(a, [row()])).toBe("stale");
        expect(await wm.wanted.active()).toEqual([]);
        expect(await wm.wanted.marks.count()).toBe(1);
        expect(await finish(a, [row()], { revision: 1 })).toBe("written");
        expect(await wm.wanted.active()).toHaveLength(1);
        expect(await wm.wanted.marks.count()).toBe(0);
      });

      it(`past ${WANTED_OPEN_MAX} open items a new one isn't added, none is dropped for it, and one there still gains a rule`, async () => {
        const { wm, got, mark, finish } = await setup();
        const a = await got();
        await mark(a);
        await finish(a, Array.from({ length: WANTED_OPEN_MAX }, (_, i) => row({ quote: `line ${i}`, actAt: NOW + i })));
        const full = await wm.wanted.active();
        expect(full).toHaveLength(WANTED_OPEN_MAX);
        await mark(a);
        expect(await finish(a, [row({ quote: "one more" }), row({ quote: "line 7", rules: ["s2"] })])).toBe("written");
        const after = await wm.wanted.active();
        expect(after.map((r) => r.id)).toEqual(full.map((r) => r.id));
        expect(after[7]!.rules).toEqual(["s1", "s2"]);
        expect(await wm.wanted.marks.count()).toBe(0);
        // one handled: there's room for one
        expect(await wm.wanted.act([{ id: full[0]!.id, revision: 0, patch: { state: "done", closedReason: "user", closedAt: NOW } }])).not.toBeNull();
        await mark(a);
        await finish(a, [row({ quote: "one more" }), row({ quote: "and another" })]);
        const last = await wm.wanted.active();
        expect(last).toHaveLength(WANTED_OPEN_MAX);
        expect(last.filter((r) => r.quote === "one more" || r.quote === "and another").map((r) => r.quote)).toEqual(["one more"]);
      });
    });

    describe("acting on a wanted item", () => {
      it("each change at its revision, all or none; Undo puts each back as it was, unless one changed since", async () => {
        const { store, wm, wanted } = await setup();
        await wanted([row(), row({ kind: "pay", quote: "pay by Friday", actAt: NOW + DAY })]);
        const [pay, renew] = await wm.wanted.active();
        const done = { state: "done" as const, closedReason: "user", closedAt: NOW + 5 };
        // one of them changed elsewhere: neither is written
        expect(await wm.wanted.act([{ id: pay!.id, revision: 0, patch: done }, { id: renew!.id, revision: 1, patch: done }])).toBeNull();
        expect(await wm.wanted.act([{ id: pay!.id, revision: 0, patch: done }, { id: 999_999, revision: 0, patch: done }])).toBeNull();
        expect((await wm.wanted.active()).map((r) => [r.id, r.revision])).toEqual([[pay!.id, 0], [renew!.id, 0]]);
        const before = await wm.wanted.act([{ id: pay!.id, revision: 0, patch: done }, { id: renew!.id, revision: 0, patch: { deferredUntil: NOW + DAY } }]);
        expect(before).toEqual([
          { id: pay!.id, revision: 0, state: "open", deferredUntil: null, closedReason: null, closedAt: null },
          { id: renew!.id, revision: 0, state: "open", deferredUntil: null, closedReason: null, closedAt: null },
        ]);
        expect(await wm.wanted.get(pay!.id)).toMatchObject({ state: "done", closedReason: "user", closedAt: NOW + 5, deferredUntil: null, revision: 1 });
        expect(await wm.wanted.get(renew!.id)).toMatchObject({ state: "open", deferredUntil: NOW + DAY, revision: 1 });
        // only what's open is active, here and on its thread
        expect((await wm.wanted.active()).map((r) => r.id)).toEqual([renew!.id]);
        expect((await wm.wanted.ofThread(renew!.threadId)).map((r) => r.id)).toEqual([renew!.id]);
        const again = await reopen(store);
        expect(await again.whatMatters.wanted.restore(before!)).toBe(true);
        expect((await again.whatMatters.wanted.active()).map((r) => [r.id, r.state, r.deferredUntil, r.closedAt, r.revision])).toEqual([[pay!.id, "open", null, null, 2], [renew!.id, "open", null, null, 2]]);
        // an Undo used twice does nothing
        expect(await again.whatMatters.wanted.restore(before!)).toBe(false);
        // one of an act's two changed since: its Undo puts neither back
        const second = await again.whatMatters.wanted.act([{ id: pay!.id, revision: 2, patch: done }, { id: renew!.id, revision: 2, patch: done }]);
        await again.whatMatters.wanted.act([{ id: renew!.id, revision: 3, patch: { state: "dismissed" } }]);
        expect(await again.whatMatters.wanted.restore(second!)).toBe(false);
        expect([(await again.whatMatters.wanted.get(pay!.id))!.state, (await again.whatMatters.wanted.get(renew!.id))!.state]).toEqual(["done", "dismissed"]);
      });
    });

    describe("reconcile", () => {
      it("an item none of whose rules is current is an orphan from then, until one is again; orphans and closed items go in time", async () => {
        const { wm, wanted } = await setup();
        await wanted([row({ quote: "one", actAt: NOW + 1 }), row({ quote: "two", actAt: NOW + 2, rules: ["s2"] }), row({ quote: "both", actAt: NOW + 3, rules: ["s1", "s2"] })]);
        const orphaned = async () => (await wm.wanted.active()).map((r) => r.orphanedAt);
        expect(await wm.wanted.reconcile(new Set(["s1"]), NOW)).toBe(0);
        expect(await orphaned()).toEqual([null, NOW, null]);
        // still one: since the first time
        expect(await wm.wanted.reconcile(new Set(["s1", "s9"]), NOW + 50)).toBe(0);
        expect(await orphaned()).toEqual([null, NOW, null]);
        // an edit back (or an Undo): shown again
        expect(await wm.wanted.reconcile(new Set(["s2"]), NOW + 60)).toBe(0);
        expect(await orphaned()).toEqual([NOW + 60, null, null]);
        expect(await wm.wanted.reconcile(new Set(["s2"]), NOW + 60 + WANTED_ORPHAN_KEEP_MS)).toBe(0);
        expect(await wm.wanted.reconcile(new Set(["s2"]), NOW + 61 + WANTED_ORPHAN_KEEP_MS)).toBe(1);
        expect((await wm.wanted.active()).map((r) => r.quote)).toEqual(["two", "both"]);
        // a closed one is kept for the history, then goes, its rules current or not
        const [two, both] = await wm.wanted.active();
        await wm.wanted.act([{ id: two!.id, revision: 0, patch: { state: "done", closedReason: "user", closedAt: NOW + 100 } }]);
        expect(await wm.wanted.reconcile(new Set(["s2"]), NOW + 100 + WANTED_CLOSED_KEEP_MS)).toBe(0);
        expect(await wm.wanted.get(two!.id)).not.toBeNull();
        expect(await wm.wanted.reconcile(new Set(["s2"]), NOW + 101 + WANTED_CLOSED_KEEP_MS)).toBe(1);
        expect(await wm.wanted.get(two!.id)).toBeNull();
        expect((await wm.wanted.active()).map((r) => r.id)).toEqual([both!.id]);
        // no rule at all (the box cleared): what's left is an orphan
        expect(await wm.wanted.reconcile(new Set(), NOW + 200)).toBe(0);
        expect(await orphaned()).toEqual([NOW + 200]);
      });

      it("a rule that wants an orphan again takes it back at the finish", async () => {
        const { wm, got, mark, finish } = await setup();
        const a = await got();
        await mark(a);
        await finish(a, [row()]);
        await wm.wanted.reconcile(new Set(), NOW);
        expect((await wm.wanted.active())[0]!.orphanedAt).toBe(NOW);
        await mark(a);
        await finish(a, [row({ rules: ["s7"] })]);
        expect((await wm.wanted.active()).map((r) => [r.rules, r.orphanedAt])).toEqual([[["s1", "s7"], null]]);
      });
    });

    describe("the look back's walk", () => {
      it("received mail since then, newest first, whatever its tab and whether a dated item was read in it; never Spam, Trash, sent or the user's own", async () => {
        const { store, wm, accountId, got } = await setup();
        const plain = await got({ subject: "Your membership", date: NOW - 5000 });
        const promo = await got({ subject: "Renew and save", date: NOW - 4000, gmailLabels: ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"] });
        expect((await store.threads.list({ view: "inbox", accountId, tab: "promotions", limit: 10 })).items.map((t) => t.id)).toEqual([promo.thread]);
        // read by the dated reader, an item kept from it
        const bill = msg({ accountId, from: gym, to: [me], subject: "Invoice", date: NOW - 3000 });
        const r = await store.sync.ingest([bill], { applyFilters: false, now: NOW, classifier: null, datedMail: { since: null } });
        const billThread = await threadOf(store, bill.providerMsgId!);
        expect(await store.dated.finish({ messageId: r.inserted[0]!, threadId: billThread, fromScan: false, rows: [{ kind: "pay", item: 0, text: "Pay", quote: "due", dueDay: "2026-11-30", dueAt: NOW + DAY, timed: false, dated: true, actAt: NOW + DAY }], settled: [], now: NOW, model: "m", provider: "p", promptVersion: 1, clearGeneration: store.dated.clearGeneration() })).toBe("written");
        await got({ date: NOW - 6001 });
        for (const over of [{ isSent: true, from: me, to: [gym], inInbox: false }, { isSpam: true }, { isTrash: true }, { isDraft: true }, { from: me }] satisfies Partial<IncomingMessage>[]) await got({ date: NOW - 2000, ...over });
        const found = await wm.wanted.lookCandidates(NOW - 6000, 10);
        expect(found.map((c) => c.id)).toEqual([r.inserted[0]!, promo.id, plain.id]);
        expect(found[2]).toEqual({ id: plain.id, threadId: plain.thread, accountId, subject: "Your membership", fromName: "Gym", fromEmail: "hello@gym.test", date: NOW - 5000 });
        // at most the walk, the newest
        expect((await wm.wanted.lookCandidates(NOW - 6000, 2)).map((c) => c.id)).toEqual([r.inserted[0]!, promo.id]);
        expect(await wm.wanted.lookCandidates(NOW, 10)).toEqual([]);
      });
    });

    describe("with their thread", () => {
      it("a merge moves the items and the marks to the surviving thread; a reading from before it lands there", async () => {
        const { wm, got, mark, finish } = await setup();
        const a = await got({ subject: "One", providerMsgId: "wa", rfcMessageId: "wa@x", date: NOW - 9000 });
        const b = await got({ subject: "Two", providerMsgId: "wb", rfcMessageId: "wb@x", date: NOW - 8000 });
        const c = await got({ subject: "Three", providerMsgId: "wc", rfcMessageId: "wc@x", date: NOW - 7000 });
        for (const x of [a, b, c]) await mark(x);
        await finish(a, [row()]);
        await finish(b, [row()]);
        const bridge = await got({ subject: "Re", providerMsgId: "wd", rfcMessageId: "wd@x", references: ["wa@x", "wb@x", "wc@x"], inReplyTo: "wc@x", date: NOW - 6000 });
        const rows = await wm.wanted.active();
        expect(rows.map((r) => r.threadId)).toEqual([bridge.thread, bridge.thread]);
        // what moved is at a new revision: what was shown has changed
        expect(rows.filter((r) => r.revision === 1)).toHaveLength([a, b].filter((x) => x.thread !== bridge.thread).length);
        expect((await wm.wanted.marks.page(10)).map((m) => [m.messageId, m.threadId])).toEqual([[c.id, bridge.thread]]);
        // c was read while another thread was still there: the item is the survivor's, never a failed write
        const stale = [a, b, c].map((x) => x.thread).find((t) => t !== bridge.thread)!;
        expect(await finish(c, [row({ quote: "three" })], { threadId: stale })).toBe("written");
        expect((await wm.wanted.ofThread(bridge.thread)).map((r) => r.messageId).sort((x, y) => x - y)).toEqual([a.id, b.id, c.id]);
        expect(await wm.wanted.marks.count()).toBe(0);
      });

      it("go with their thread, and with nothing else", async () => {
        const { store, wm, other, got, mark, finish, wanted } = await setup();
        const mine = await wanted([row()]);
        const kept = await got();
        await mark(kept);
        const theirs = await got({ accountId: other });
        await mark(theirs);
        await finish(theirs, [row()]);
        const waiting = await got({ accountId: other });
        await mark(waiting, "look");
        expect([(await wm.wanted.active()).length, await wm.wanted.marks.count()]).toEqual([2, 2]);
        await store.accounts.remove(other);
        expect((await wm.wanted.active()).map((r) => r.threadId)).toEqual([mine.thread]);
        expect((await wm.wanted.marks.page(10)).map((m) => m.messageId)).toEqual([kept.id]);
      });
    });

    describe("Clear", () => {
      it("the dated items' Clear leaves the wanted ones, and theirs empties the items and the marks alone", async () => {
        const { store, wm, accountId, got, mark } = await setup();
        await wm.preferences.save(words("Show me gym renewals"), 0);
        await wm.verdicts.put([{ target: "d:1:0", basis: "b", rules: [], at: NOW }], 1);
        const a = await got();
        await mark(a);
        expect(await wm.wanted.finish({ messageId: a.id, threadId: a.thread, senderKey: "hello@gym.test", arrivedAt: a.m.date, rows: [row()], now: NOW, model: "m", provider: "p", promptVersion: 1, fromLook: false, revision: 1 })).toBe("written");
        const pending = await got();
        await mark(pending);
        const bill = msg({ accountId, from: gym, to: [me], date: NOW - 3000 });
        const r = await store.sync.ingest([bill], { applyFilters: false, now: NOW, classifier: null, datedMail: { since: null } });
        const dated = { messageId: r.inserted[0]!, threadId: await threadOf(store, bill.providerMsgId!), fromScan: false, rows: [{ kind: "pay" as const, item: 0, text: "Pay", quote: "due", dueDay: "2026-11-30", dueAt: NOW + DAY, timed: false, dated: true, actAt: NOW + DAY }], settled: [], now: NOW, model: "m", provider: "p", promptVersion: 1 };
        expect(await store.dated.finish({ ...dated, clearGeneration: store.dated.clearGeneration() })).toBe("written");
        // a wanted item is never one of the dated reader's
        expect(await store.dated.active()).toHaveLength(1);
        await store.dated.clear();
        expect(await store.dated.active()).toEqual([]);
        expect([(await wm.wanted.active()).length, await wm.wanted.marks.count()]).toEqual([1, 1]);
        await wm.wanted.clear();
        expect([(await wm.wanted.active()).length, await wm.wanted.marks.count()]).toEqual([0, 0]);
        // the words and their verdicts are another Clear's
        expect(await wm.preferences.get()).toMatchObject({ text: "Show me gym renewals", revision: 1 });
        expect((await wm.verdicts.get(["d:1:0"])).size).toBe(1);
      });
    });
  });
}
