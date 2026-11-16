import { describe, expect, it } from "vitest";
import type { DatedFinish, DatedWrite } from "../dated";
import type { MailStore } from "../mail-store";
import type { IncomingMessage } from "../types";
import { msg, threadOf, withAccounts } from "./fixtures";

const NOW = Date.UTC(2026, 10, 13, 12);
const DAY = 86_400_000;
const me = { name: "Me", email: "me0@example.com" };
const elena = { name: "Elena Ruiz", email: "elena@school.test" };

/**
 * Plan 210 (iteration 4, the owner's "Change…"): the user's day and time on an item and a promise, revision-checked, all or
 * none, exact for Undo; from then on a later mail's move is the user's to take (a proposal), never applied.
 */
export function defineScheduleConformance(fresh: () => Promise<MailStore>, reopen: (store: MailStore) => Promise<MailStore>): void {
  describe("Change… (plan 210, iteration 4)", () => {
    async function setup() {
      const store = await fresh();
      const [accountId] = await withAccounts(store, 1);
      const got = async (over: Partial<IncomingMessage> = {}) => {
        const m = msg({ accountId: accountId!, from: elena, to: [me], date: NOW - 60_000, ...over });
        const r = await store.sync.ingest([m], { applyFilters: false, now: NOW, classifier: null, datedMail: { since: null } });
        return { id: r.inserted[0]!, thread: await threadOf(store, m.providerMsgId!) };
      };
      const item = (over: Partial<DatedWrite> = {}): DatedWrite => ({ kind: "respond", item: 0, text: "Send Elena the signed slip", quote: "by Friday", dueDay: "2026-11-20", dueAt: NOW + 7 * DAY, timed: false, dated: true, actAt: NOW + 4 * DAY, ...over });
      const finish = (messageId: number, threadId: number, over: Partial<DatedFinish> = {}) =>
        store.dated.finish({ messageId, threadId, fromScan: false, rows: [], settled: [], now: NOW, model: "m", provider: "p", promptVersion: 1, clearGeneration: store.dated.clearGeneration(), ...over });
      const dated = async (key: string, over: Partial<DatedWrite> = {}) => {
        const m = await got({ providerMsgId: key, rfcMessageId: `${key}@x`, subject: key });
        await finish(m.id, m.thread, { rows: [item(over)] });
        return { thread: m.thread, row: (await store.dated.ofThread(m.thread))[0]! };
      };
      const promise = async (key: string, over: { dueAt?: number; timed?: boolean } = {}) => {
        const m = msg({ accountId: accountId!, from: me, to: [elena], isSent: true, inInbox: false, rfcMessageId: `${key}@x`, date: NOW - 9000, providerMsgId: `${key}-sent` });
        const r = await store.sync.ingest([m], { applyFilters: false, now: NOW, classifier: null, liveSent: { wanted: true } });
        const thread = await threadOf(store, `${key}-sent`);
        await store.followups.finish({ messageId: r.inserted[0]!, threadId: thread, fromScan: false, rows: [{ kind: "promise", item: 0, text: "send the script", quote: "I'll send the script", personName: elena.name, personEmail: elena.email, dueAt: over.dueAt ?? NOW + DAY, dated: true, ...(over.timed !== undefined ? { timed: over.timed } : {}) }], kept: [], now: NOW, model: "m", provider: "p", promptVersion: 1, clearGeneration: store.followups.clearGeneration() });
        return { thread, row: (await store.followups.ofThread(thread))[0]! };
      };
      /** a later message from Elena on that conversation */
      const reply = (key: string, date: number) => got({ inReplyTo: `${key}@x`, references: [`${key}@x`], date });
      return { store, got, finish, dated, promise, reply };
    }

    it("changes a dated item and a promise at once: the new day and time, Later cleared, the change recorded; Undo puts every field back", async () => {
      const { store, dated, promise } = await setup();
      const slip = await dated("slip");
      await store.dated.update(slip.row.id, slip.row.revision, { deferredUntil: NOW + 2 * DAY });
      const script = await promise("script", { dueAt: NOW + DAY });
      const was = { dated: (await store.dated.get(slip.row.id))!, promise: script.row };
      const snapshots = await store.today.schedule({
        at: NOW,
        dated: [{ id: slip.row.id, revision: was.dated.revision, to: { dueDay: "2026-11-23", dueAt: NOW + 10 * DAY, timed: true, actAt: NOW + 3 * DAY } }],
        promises: [{ id: script.row.id, revision: script.row.revision, to: { dueAt: NOW + 5 * DAY, timed: false, state: "open" } }],
      });
      expect(snapshots).toEqual({
        dated: [{ id: slip.row.id, revision: was.dated.revision, dueDay: "2026-11-20", dueAt: NOW + 7 * DAY, timed: false, dated: true, actAt: NOW + 4 * DAY, text: "Send Elena the signed slip", deferredUntil: NOW + 2 * DAY, changedAt: null, changedFrom: null, proposal: null, before: null, wall: null }],
        promises: [{ id: script.row.id, revision: script.row.revision, state: "open", inboxState: "none", dueAt: NOW + DAY, dated: true, timed: false, brokenDueAt: null, deferredUntil: null, changedAt: null, changedFrom: null, proposal: null, before: null }],
      });
      expect(await store.dated.get(slip.row.id)).toMatchObject({
        dueDay: "2026-11-23", dueAt: NOW + 10 * DAY, timed: true, dated: true, actAt: NOW + 3 * DAY, deferredUntil: null, text: "Send Elena the signed slip",
        changedAt: NOW, changedFrom: { dueDay: "2026-11-20", dueAt: NOW + 7 * DAY, timed: false, dated: true }, proposal: null, revision: was.dated.revision + 1,
      });
      expect(await store.followups.get(script.row.id)).toMatchObject({ dueAt: NOW + 5 * DAY, dated: true, timed: false, state: "open", changedAt: NOW, proposal: null, revision: script.row.revision + 1 });
      expect((await store.followups.get(script.row.id))!.changedFrom).toMatchObject({ dueAt: NOW + DAY, timed: false, dated: true });
      // its Undo: every field as it was (a revision on)
      expect(await store.today.unschedule(snapshots!)).toBe(true);
      expect(await store.dated.get(slip.row.id)).toEqual({ ...was.dated, revision: was.dated.revision + 2 });
      expect(await store.followups.get(script.row.id)).toEqual({ ...was.promise, revision: was.promise.revision + 2 });
      // a second Undo of the same change finds them moved on: nothing
      expect(await store.today.unschedule(snapshots!)).toBe(false);
    });

    it("a stale revision or a closed item changes nothing, all or none; an Undo after another change since restores nothing", async () => {
      const { store, dated, promise } = await setup();
      const slip = await dated("slip");
      const script = await promise("script");
      const change = (datedRevision: number, promiseRevision: number) => ({
        at: NOW,
        dated: [{ id: slip.row.id, revision: datedRevision, to: { dueDay: "2026-11-23", dueAt: NOW + 10 * DAY, timed: false, actAt: NOW + 3 * DAY } }],
        promises: [{ id: script.row.id, revision: promiseRevision, to: { dueAt: NOW + 5 * DAY, timed: false, state: "open" as const } }],
      });
      expect(await store.today.schedule(change(slip.row.revision, script.row.revision + 1))).toBeNull();
      expect(await store.dated.get(slip.row.id)).toMatchObject({ dueDay: "2026-11-20", changedAt: null, revision: slip.row.revision });
      expect(await store.followups.get(script.row.id)).toMatchObject({ dueAt: script.row.dueAt, changedAt: null, revision: script.row.revision });
      // closed since: refused at its very revision
      const done = await store.dated.update(slip.row.id, slip.row.revision, { state: "done", closedReason: "user", closedAt: NOW });
      expect(await store.today.schedule(change(done!.revision + 1, script.row.revision))).toBeNull();
      await store.dated.update(slip.row.id, done!.revision + 1, { state: "open", closedReason: null, closedAt: null });
      const changed = (await store.today.schedule(change(slip.row.revision + 2, script.row.revision)))!;
      // a Later since: the change's Undo restores neither
      await store.followups.update(script.row.id, script.row.revision + 1, { deferredUntil: NOW + 2 * DAY });
      expect(await store.today.unschedule(changed)).toBe(false);
      expect(await store.dated.get(slip.row.id)).toMatchObject({ dueDay: "2026-11-23", changedAt: NOW });
      expect(await store.followups.get(script.row.id)).toMatchObject({ dueAt: NOW + 5 * DAY, deferredUntil: NOW + 2 * DAY });
    });

    it("a promise past its day, broken and moved, changed to a day ahead: open again, its broken day gone; Undo brings both back", async () => {
      const { store, promise, reply, finish } = await setup();
      const late = await promise("late", { dueAt: NOW - 2 * DAY });
      const r = await reply("late", NOW - 3000);
      await finish(r.id, r.thread, { movedPromises: [{ id: late.row.id, revision: late.row.revision, dueAt: NOW - DAY, brokenDueAt: NOW - 2 * DAY }] });
      await store.followups.makeDue(NOW);
      const was = (await store.followups.get(late.row.id))!;
      expect(was).toMatchObject({ state: "due", brokenDueAt: NOW - 2 * DAY });
      const s = (await store.today.schedule({ at: NOW, dated: [], promises: [{ id: was.id, revision: was.revision, to: { dueAt: NOW + 3 * DAY, timed: true, state: "open" } }] }))!;
      expect(await store.followups.get(was.id)).toMatchObject({ state: "open", inboxState: "none", dueAt: NOW + 3 * DAY, timed: true, brokenDueAt: null });
      expect(await store.today.unschedule(s)).toBe(true);
      expect(await store.followups.get(was.id)).toEqual({ ...was, revision: was.revision + 2 });
    });

    it("a later mail's move of an item the user changed is kept as a proposal, its words with it; another item still moves", async () => {
      const { store, dated, reply, finish } = await setup();
      const slip = await dated("slip");
      const other = await dated("other");
      await store.today.schedule({ at: NOW, dated: [{ id: slip.row.id, revision: slip.row.revision, to: { dueDay: "2026-11-23", dueAt: NOW + 10 * DAY, timed: false, actAt: NOW + 3 * DAY } }], promises: [] });
      const mine = (await store.dated.get(slip.row.id))!;
      const r = await reply("slip", NOW - 1000);
      await finish(r.id, r.thread, {
        moved: [
          { id: slip.row.id, dueDay: "2026-11-16", dueAt: NOW + 3 * DAY, timed: true, actAt: NOW, text: "Send Elena the slip by Monday" },
          { id: other.row.id, dueDay: "2026-11-16", dueAt: NOW + 3 * DAY, timed: false, actAt: NOW },
        ],
      });
      // the user's day stays; the mail's waits, with who said it and the message
      expect(await store.dated.get(slip.row.id)).toMatchObject({
        dueDay: "2026-11-23", dueAt: NOW + 10 * DAY, timed: false, text: "Send Elena the signed slip", changedAt: NOW, revision: mine.revision + 1,
        proposal: { dueDay: "2026-11-16", dueAt: NOW + 3 * DAY, timed: true, actAt: NOW, text: "Send Elena the slip by Monday", by: "Elena Ruiz", messageId: r.id, at: NOW },
      });
      // never changed by the user: moved as before (its revision kept)
      expect(await store.dated.get(other.row.id)).toMatchObject({ dueDay: "2026-11-16", proposal: null, changedAt: null, revision: other.row.revision });
      // taking it is a change like any (the proposal goes); its Undo brings the proposal back
      const proposed = (await store.dated.get(slip.row.id))!;
      const took = (await store.today.schedule({ at: NOW + 1, dated: [{ id: slip.row.id, revision: proposed.revision, to: { dueDay: "2026-11-16", dueAt: NOW + 3 * DAY, timed: true, actAt: NOW, text: "Send Elena the slip by Monday" } }], promises: [] }))!;
      expect(await store.dated.get(slip.row.id)).toMatchObject({ dueDay: "2026-11-16", text: "Send Elena the slip by Monday", proposal: null, changedAt: NOW + 1, changedFrom: { dueDay: "2026-11-23" } });
      expect(await store.today.unschedule(took)).toBe(true);
      expect(await store.dated.get(slip.row.id)).toEqual({ ...proposed, revision: proposed.revision + 2 });
      // a later mail that says the user's own day takes the proposal away
      const now = (await store.dated.get(slip.row.id))!;
      const again = await reply("slip", NOW - 500);
      await finish(again.id, again.thread, { moved: [{ id: slip.row.id, dueDay: "2026-11-23", dueAt: NOW + 10 * DAY, timed: false, actAt: NOW + 3 * DAY }] });
      expect(await store.dated.get(slip.row.id)).toMatchObject({ dueDay: "2026-11-23", proposal: null, revision: now.revision + 1 });
    });

    it("the day asked before and the mail's clock are the mail's words about its day: a change of the user's takes them away, its Undo brings them back, and taking a proposal takes the move's (plan 210, iteration 4, merge)", async () => {
      const { store, dated, promise, reply, finish } = await setup();
      const austin = { day: "2026-11-20", time: "16:00", zone: "America/Chicago", place: "Austin" };
      const talk = await dated("talk", { kind: "event", text: "Keynote", before: "2026-11-21", wall: austin });
      const script = await promise("script", { dueAt: NOW + DAY });
      const asked = await reply("script", NOW - 3000);
      await finish(asked.id, asked.thread, { movedPromises: [{ id: script.row.id, revision: script.row.revision, dueAt: NOW + 2 * DAY, before: "2026-11-16" }] });
      const was = { dated: (await store.dated.get(talk.row.id))!, promise: (await store.followups.get(script.row.id))! };
      expect([was.dated.before, was.dated.wall, was.promise.before]).toEqual(["2026-11-21", austin, "2026-11-16"]);
      const s = (await store.today.schedule({
        at: NOW,
        dated: [{ id: talk.row.id, revision: was.dated.revision, to: { dueDay: "2026-11-23", dueAt: NOW + 10 * DAY, timed: false, actAt: NOW + 3 * DAY } }],
        promises: [{ id: script.row.id, revision: was.promise.revision, to: { dueAt: NOW + 5 * DAY, timed: false, state: "open" } }],
      }))!;
      expect([s.dated[0]!.before, s.dated[0]!.wall, s.promises[0]!.before]).toEqual(["2026-11-21", austin, "2026-11-16"]);
      expect(await store.dated.get(talk.row.id)).toMatchObject({ dueDay: "2026-11-23", before: null, wall: null });
      expect(await store.followups.get(script.row.id)).toMatchObject({ dueAt: NOW + 5 * DAY, before: null });
      expect(await store.today.unschedule(s)).toBe(true);
      expect(await store.dated.get(talk.row.id)).toEqual({ ...was.dated, revision: was.dated.revision + 2 });
      expect(await store.followups.get(script.row.id)).toEqual({ ...was.promise, revision: was.promise.revision + 2 });
      // changed again, then a later mail moves it with its own "before" and clock: kept on the proposal, and taken with it
      const mine = (await store.dated.get(talk.row.id))!;
      await store.today.schedule({ at: NOW, dated: [{ id: talk.row.id, revision: mine.revision, to: { dueDay: "2026-11-23", dueAt: NOW + 10 * DAY, timed: false, actAt: NOW + 3 * DAY } }], promises: [] });
      const moved = await reply("talk", NOW - 1000);
      const there = { day: "2026-11-17", time: "09:30", zone: "America/Chicago", place: "Austin" };
      await finish(moved.id, moved.thread, { moved: [{ id: talk.row.id, dueDay: "2026-11-17", dueAt: NOW + 4 * DAY, timed: true, actAt: NOW, before: "2026-11-18", wall: there }] });
      const proposed = (await store.dated.get(talk.row.id))!;
      expect(proposed).toMatchObject({ dueDay: "2026-11-23", before: null, wall: null, proposal: { dueDay: "2026-11-17", before: "2026-11-18", wall: there } });
      await store.today.schedule({ at: NOW + 1, dated: [{ id: talk.row.id, revision: proposed.revision, to: { dueDay: "2026-11-17", dueAt: NOW + 4 * DAY, timed: true, actAt: NOW, before: proposed.proposal!.before, wall: proposed.proposal!.wall } }], promises: [] });
      expect(await store.dated.get(talk.row.id)).toMatchObject({ dueDay: "2026-11-17", before: "2026-11-18", wall: there, proposal: null });
    });

    it("a later mail's move of a promise the user changed is a proposal only at the revision the reader saw, on its thread", async () => {
      const { store, promise, reply, got, finish } = await setup();
      const script = await promise("script", { dueAt: NOW + DAY });
      await store.today.schedule({ at: NOW, dated: [], promises: [{ id: script.row.id, revision: script.row.revision, to: { dueAt: NOW + 4 * DAY, timed: false, state: "open" } }] });
      const mine = (await store.followups.get(script.row.id))!;
      const stale = await reply("script", NOW - 3000);
      await finish(stale.id, stale.thread, { movedPromises: [{ id: script.row.id, revision: mine.revision - 1, dueAt: NOW + 2 * DAY }] });
      const elsewhere = await got({ date: NOW - 2500 });
      await finish(elsewhere.id, elsewhere.thread, { movedPromises: [{ id: script.row.id, revision: mine.revision, dueAt: NOW + 2 * DAY }] });
      expect(await store.followups.get(script.row.id)).toEqual(mine);
      const r = await reply("script", NOW - 2000);
      await finish(r.id, r.thread, { movedPromises: [{ id: script.row.id, revision: mine.revision, dueAt: NOW + 2 * DAY, timed: true, brokenDueAt: null }] });
      const after = (await store.followups.get(script.row.id))!;
      expect(after).toMatchObject({ dueAt: NOW + 4 * DAY, timed: false, brokenDueAt: null, revision: mine.revision + 1 });
      expect(after.proposal).toMatchObject({ dueAt: NOW + 2 * DAY, timed: true, by: "Elena Ruiz", messageId: r.id, at: NOW });
    });

    it("what a change wrote, and a proposal, are there after the store is opened again", async () => {
      const { store, dated, reply, finish } = await setup();
      const slip = await dated("slip");
      await store.today.schedule({ at: NOW, dated: [{ id: slip.row.id, revision: slip.row.revision, to: { dueDay: "2026-11-23", dueAt: NOW + 10 * DAY, timed: false, actAt: NOW + 3 * DAY } }], promises: [] });
      const r = await reply("slip", NOW - 1000);
      await finish(r.id, r.thread, { moved: [{ id: slip.row.id, dueDay: "2026-11-16", dueAt: NOW + 3 * DAY, timed: false, actAt: NOW }] });
      const before = (await store.dated.get(slip.row.id))!;
      const next = await reopen(store);
      expect(await next.dated.get(slip.row.id)).toEqual(before);
      expect(before.proposal).toMatchObject({ dueDay: "2026-11-16" });
      expect(before.changedFrom).toMatchObject({ dueDay: "2026-11-20" });
    });
  });
}
