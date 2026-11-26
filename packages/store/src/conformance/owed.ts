import { describe, expect, it } from "vitest";
import { AWAITING_ITEM, FOLLOWUPS_ACTIVE_MAX, type FollowupFinish, type FollowupWrite } from "../followups";
import type { MailStore } from "../mail-store";
import { OWED_MARK_MS, OWED_SCAN_MARK_MS, type OwedFinish, type OwedWrite } from "../owed";
import type { IncomingMessage } from "../types";
import { msg, threadOf, withAccounts } from "./fixtures";

const NOW = Date.UTC(2026, 10, 5, 12);
const DAY = 86_400_000;
const me = { name: "Me", email: "me0@example.com" };
const alex = { name: "Alex Reed", email: "alex@acme.test" };
const bea = { name: "Bea", email: "bea@acme.test" };

/**
 * Plan 280: their promises to you. Received mail is marked by its own marker while the follow-ups reader wants it; a
 * promise is the sender's own, and only the debtor's own later mail, in the account, at the revision shown, keeps, moves
 * or withdraws it; a relay only hints. One admission rule at the bound; a tentative or checked one never goes on top; a
 * promise of theirs your mail records, or closes, only from a send that's yours for certain.
 */
export function defineOwedConformance(fresh: () => Promise<MailStore>, reopen: (store: MailStore) => Promise<MailStore>): void {
  describe("Owed to you (plan 280)", () => {
    async function setup() {
      const store = await fresh();
      const [accountId, other] = await withAccounts(store, 2);
      const got = async (over: Partial<IncomingMessage> = {}, owedMail: { since: number | null } | null = { since: null }, at = NOW) => {
        const m = msg({ accountId: accountId!, from: alex, to: [me], date: at - 60_000, ...over });
        const r = await store.sync.ingest([m], { applyFilters: false, now: at, classifier: null, ...(owedMail ? { owedMail } : {}) });
        return { id: r.inserted[0]!, thread: await threadOf(store, m.providerMsgId!), m };
      };
      const owed = (over: Partial<OwedWrite> = {}): OwedWrite => ({ item: 200, text: "send you the contract", quote: "I'll send you the contract", personName: "Alex Reed", personEmail: alex.email, dueAt: NOW + 2 * DAY, dated: true, dueDay: "2026-11-06", firm: true, ...over });
      const finish = (messageId: number, threadId: number, over: Partial<OwedFinish> = {}) =>
        store.followups.owed.finish({ messageId, threadId, fromScan: false, rows: [], kept: [], moved: [], withdrawn: [], hints: [], now: NOW, model: "m", provider: "p", promptVersion: 1, clearGeneration: store.followups.clearGeneration(), ...over });
      /** a promise of Alex's, read from his mail */
      const promised = async (over: Partial<OwedWrite> = {}, mail: Partial<IncomingMessage> = {}) => {
        const a = await got(mail);
        expect(await finish(a.id, a.thread, { rows: [owed(over)] })).toBe("written");
        const row = (await store.followups.ofThread(a.thread)).find((r) => r.kind === "theirs" && r.messageId === a.id)!;
        return { ...a, row };
      };
      return { store, accountId: accountId!, other: other!, got, owed, finish, promised };
    }

    describe("the marker", () => {
      it("marks live received mail once, only when asked; never your own, Spam, Trash or a draft; re-ingest doesn't double it", async () => {
        const { store, got } = await setup();
        const a = await got();
        await got({}, null);
        await got({ isSpam: true });
        await got({ isTrash: true });
        await got({ isDraft: true });
        await got({ from: me, to: [alex], isSent: true, inInbox: false });
        await got({ date: NOW - 10 * DAY });
        const page = await store.followups.owed.marks.page(null, 50);
        expect(page.map((m) => m.messageId)).toEqual([a.id]);
        expect(page[0]).toMatchObject({ threadId: a.thread, senderKey: alex.email, source: "live" });
        await store.sync.ingest([a.m], { applyFilters: false, now: NOW, classifier: null, owedMail: { since: null } });
        expect(await store.followups.owed.marks.count()).toBe(1);
        // the dated reader's marker is never written by it
        expect(await store.dated.marks.count()).toBe(0);
      });

      it("mail from before Follow-ups went on isn't marked", async () => {
        const { store, got } = await setup();
        await got({}, { since: NOW - 1000 });
        expect(await store.followups.owed.marks.count()).toBe(0);
      });

      it("a check's marks live 14 days and a live one 3; a check never resets a live mark; marks go with their message", async () => {
        const { store, got } = await setup();
        const a = await got();
        const b = await got({}, null);
        expect(await store.followups.owed.marks.queueScan([a.id, b.id], NOW)).toBe(1);
        expect((await store.followups.owed.marks.page(null, 9)).map((m) => [m.messageId, m.source])).toEqual([[a.id, "live"], [b.id, "scan"]]);
        await store.followups.owed.marks.prune(NOW + OWED_MARK_MS + 1);
        expect((await store.followups.owed.marks.page(null, 9)).map((m) => m.messageId)).toEqual([b.id]);
        await store.followups.owed.marks.prune(NOW + OWED_SCAN_MARK_MS + 1);
        expect(await store.followups.owed.marks.count()).toBe(0);
        const c = await got();
        await store.sync.remove([c.id]);
        expect(await store.followups.owed.marks.count()).toBe(0);
      });

      it("requeue marks a debtor's received mail in the account again, and no one else's", async () => {
        const { store, got, accountId, other } = await setup();
        const a = await got({}, null);
        await got({ from: bea }, null);
        await got({ accountId: other, to: [{ name: "Me", email: "me1@example.com" }] }, null);
        expect(await store.followups.owed.marks.requeue(alex.email, accountId, NOW - DAY, NOW)).toBe(1);
        expect((await store.followups.owed.marks.page(null, 9)).map((m) => m.messageId)).toEqual([a.id]);
      });

      it("a check takes one account's received mail in its span, newest first", async () => {
        const { store, got, accountId } = await setup();
        const older = await got({ date: NOW - 5 * DAY }, null);
        const newer = await got({ date: NOW - DAY }, null);
        await got({ date: NOW - 40 * DAY }, null);
        await got({ from: me, to: [alex], isSent: true, inInbox: false }, null);
        expect(await store.followups.owed.scanCandidates(NOW - 14 * DAY, 10, accountId)).toEqual([newer.id, older.id]);
      });

      it("survives a reopen", async () => {
        const { store, got } = await setup();
        await got();
        const back = await reopen(store);
        expect(await back.followups.owed.marks.count()).toBe(1);
      });
    });

    describe("the source", () => {
      it("is the dated reader's facts, with the message of yours it answers only when it's a send that's yours for certain", async () => {
        const { store, accountId, got } = await setup();
        const ingest = (over: Partial<IncomingMessage>) => store.sync.ingest([msg({ accountId, from: me, to: [alex], isSent: true, inInbox: false, subject: "Contract", ...over })], { applyFilters: false, now: NOW, classifier: null });
        const asked = (await ingest({ providerMsgId: "q", rfcMessageId: "q@x", gmailLabels: ["SENT"], date: NOW - 9000 })).inserted[0]!;
        await ingest({ providerMsgId: "f", rfcMessageId: "f@x", date: NOW - 8000 });
        const reply = await got({ subject: "Re: Contract", inReplyTo: "q@x", references: ["q@x"], date: NOW - 5000 });
        const src = (await store.followups.owed.source(reply.id))!;
        expect(src).toMatchObject({ senderKey: alex.email, readerIn: "to", rfcMessageId: reply.m.rfcMessageId });
        expect(src.answering?.id).toBe(asked);
        // a forged copy (IMAP marks any message claiming your From as sent) is never what it answers
        const forged = await got({ subject: "Re: Contract", inReplyTo: "f@x", references: ["f@x"], date: NOW - 4000 });
        expect((await store.followups.owed.source(forged.id))!.answering).toBeNull();
      });
    });

    describe("finish", () => {
      it("writes the sender's promise and consumes the mark; a row owed by anyone else is dropped; nothing found still consumes", async () => {
        const { store, got, owed, finish } = await setup();
        const a = await got();
        expect(await finish(a.id, a.thread, { rows: [owed(), owed({ item: 201, personEmail: bea.email, personName: "Bea" })] })).toBe("written");
        const rows = (await store.followups.active()).filter((r) => r.kind === "theirs");
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ kind: "theirs", item: 200, text: "send you the contract", personEmail: alex.email, personKey: alex.email, dueDay: "2026-11-06", dated: true, firm: true, sentAt: a.m.date, state: "open", inboxState: "none" });
        expect(await store.followups.owed.marks.count()).toBe(0);
        expect(await finish(a.id, a.thread, { rows: [owed()] })).toBe("gone");
        const b = await got();
        expect(await finish(b.id, b.thread)).toBe("written");
        expect(await store.followups.owed.marks.count()).toBe(0);
      });

      it("is gone for a message moved to Spam, a conversation with Spam, another conversation, or after Clear AI data", async () => {
        const { store, accountId, got, owed, finish } = await setup();
        const a = await got();
        await store.sync.ingest([{ ...a.m, isSpam: true, inInbox: false }], { applyFilters: false, now: NOW, classifier: null });
        expect(await finish(a.id, a.thread, { rows: [owed()] })).toBe("gone");
        const b = await got({ providerMsgId: "b1", rfcMessageId: "b1@x", subject: "Deal" });
        await store.sync.ingest([msg({ accountId, from: bea, to: [me], providerMsgId: "b2", inReplyTo: "b1@x", references: ["b1@x"], subject: "Re: Deal", isSpam: true, inInbox: false, date: NOW - 1000 })], { applyFilters: false, now: NOW, classifier: null });
        expect(await finish(b.id, b.thread, { rows: [owed()] })).toBe("gone");
        const c = await got();
        expect(await finish(c.id, c.thread + 999, { rows: [owed()] })).toBe("gone");
        const d = await got();
        const generation = store.followups.clearGeneration();
        await store.followups.clear();
        expect(await finish(d.id, d.thread, { rows: [owed()], clearGeneration: generation })).toBe("gone");
        expect((await store.followups.active()).filter((r) => r.kind === "theirs")).toEqual([]);
      });

      it("only the debtor's own later mail keeps, withdraws or moves it, at the revision shown", async () => {
        const { store, accountId, got, finish, promised } = await setup();
        const p = await promised();
        // another sender's mail in the same conversation can't keep it
        const fromBea = await got({ from: bea, date: NOW });
        await finish(fromBea.id, fromBea.thread, { kept: [{ id: p.row.id, revision: p.row.revision }] });
        expect((await store.followups.get(p.row.id))!.state).toBe("open");
        // a stale revision does nothing
        const stale = await got({ date: NOW });
        await finish(stale.id, stale.thread, { kept: [{ id: p.row.id, revision: p.row.revision + 7 }] });
        expect((await store.followups.get(p.row.id))!.state).toBe("open");
        // the debtor's own mail, in a new conversation, keeps it
        const delivered = await got({ subject: "Contract attached", date: NOW });
        await finish(delivered.id, delivered.thread, { kept: [{ id: p.row.id, revision: p.row.revision }] });
        expect(await store.followups.get(p.row.id)).toMatchObject({ state: "done", closedReason: "kept", settledBy: delivered.id, inboxState: "none" });
        // withdrawn: dismissed, said why
        const q = await promised({ item: 200 }, { subject: "Quote" });
        const sorry = await got({ date: NOW });
        await finish(sorry.id, sorry.thread, { withdrawn: [{ id: q.row.id, revision: q.row.revision }] });
        expect(await store.followups.get(q.row.id)).toMatchObject({ state: "dismissed", closedReason: "withdrawn" });
        // another account's mail from the same address can't touch it
        const r = await promised({}, { subject: "Deck" });
        const elsewhere = await got({ accountId: accountId + 1, to: [{ name: "Me", email: "me1@example.com" }], date: NOW });
        await finish(elsewhere.id, elsewhere.thread, { kept: [{ id: r.row.id, revision: r.row.revision }] });
        expect((await store.followups.get(r.row.id))!.state).toBe("open");
      });

      it("a move gives a new day, keeps the user's Later, ups the revision, and is open again when its moment is ahead", async () => {
        const { store, got, finish, promised } = await setup();
        const p = await promised({ dueAt: NOW - DAY, dueDay: "2026-11-03" });
        await store.followups.makeDue(NOW);
        const due = (await store.followups.get(p.row.id))!;
        expect(due).toMatchObject({ state: "due", inboxState: "onTop" });
        const later = await store.followups.update(due.id, due.revision, { deferredUntil: NOW + DAY });
        const deferred = (await store.followups.get(p.row.id))!;
        expect(later).not.toBeNull();
        const moved = await got({ date: NOW });
        await finish(moved.id, moved.thread, { moved: [{ id: deferred.id, revision: deferred.revision, dueAt: NOW + 4 * DAY, dueDay: "2026-11-09" }] });
        expect(await store.followups.get(p.row.id)).toMatchObject({ state: "open", inboxState: "none", dueDay: "2026-11-09", dueAt: NOW + 4 * DAY, deferredUntil: NOW + DAY, revision: deferred.revision + 1 });
      });

      it("a relay only hints, from anyone, and never closes", async () => {
        const { store, got, finish, promised } = await setup();
        const p = await promised();
        const relay = await got({ from: { name: "SignFlow", email: "noreply@signflow.test" }, date: NOW });
        await finish(relay.id, relay.thread, { hints: [{ id: p.row.id, revision: p.row.revision }], kept: [{ id: p.row.id, revision: p.row.revision }] });
        expect(await store.followups.get(p.row.id)).toMatchObject({ state: "open", arrivedHint: relay.id });
      });

      it("the code review: a conversation with anything in Spam is never material, whatever the rest of it", async () => {
        const { store, accountId, got, promised } = await setup();
        const p = await promised({}, { subject: "Deal", providerMsgId: "d1", rfcMessageId: "d1@x" });
        // a later message of the same conversation moved to Spam; the promise's own message stays in the Inbox
        await store.sync.ingest([msg({ accountId, from: bea, to: [me], providerMsgId: "d2", inReplyTo: "d1@x", references: ["d1@x"], subject: "Re: Deal", isSpam: true, inInbox: false, date: NOW - 1000 })], { applyFilters: false, now: NOW, classifier: null });
        const next = await got({ subject: "Elsewhere", date: NOW + 1000 });
        expect(await store.followups.owed.openFor({ threadId: next.thread, accountId, senderKey: alex.email, before: NOW + 1000, limit: 10 })).toEqual([]);
        expect(p.row.state).toBe("open");
      });

      it("the code review: mail older than the one that last moved it can't move it back, nor close it", async () => {
        const { store, got, finish, promised } = await setup();
        const p = await promised({ dueAt: NOW + 3 * DAY, dueDay: "2026-11-07" });
        const wed = await got({ date: NOW + 2 * DAY });
        await finish(wed.id, wed.thread, { moved: [{ id: p.row.id, revision: p.row.revision, dueAt: NOW + 9 * DAY, dueDay: "2026-11-13" }] });
        const moved = (await store.followups.get(p.row.id))!;
        expect(moved).toMatchObject({ dueDay: "2026-11-13", movedAt: wed.m.date });
        // Tuesday's mail, read again after Wednesday's (a check, a replay): nothing
        const tue = await got({ date: NOW + DAY });
        await finish(tue.id, tue.thread, { moved: [{ id: moved.id, revision: moved.revision, dueAt: NOW + 5 * DAY, dueDay: "2026-11-09" }], kept: [{ id: moved.id, revision: moved.revision }] });
        expect(await store.followups.get(p.row.id)).toMatchObject({ state: "open", dueDay: "2026-11-13", revision: moved.revision });
      });

      it("the Astra review: a relay, or a 'got it' of yours, older than the last move does nothing, in both stores alike", async () => {
        const { store, accountId, got, finish, promised } = await setup();
        const p = await promised({ dueAt: NOW + 3 * DAY, dueDay: "2026-11-07" }, { subject: "Deal", providerMsgId: "m1", rfcMessageId: "m1@x" });
        const wed = await got({ date: NOW + 2 * DAY });
        await finish(wed.id, wed.thread, { moved: [{ id: p.row.id, revision: p.row.revision, dueAt: NOW + 9 * DAY, dueDay: "2026-11-13" }] });
        const moved = (await store.followups.get(p.row.id))!;
        const relay = await got({ from: { name: "SignFlow", email: "noreply@signflow.test" }, date: NOW + DAY });
        await finish(relay.id, relay.thread, { hints: [{ id: moved.id, revision: moved.revision }] });
        expect(await store.followups.get(p.row.id)).toMatchObject({ arrivedHint: null, revision: moved.revision });
        const mine = msg({ accountId, from: me, to: [alex], isSent: true, inInbox: false, gmailLabels: ["SENT"], providerMsgId: "t-old", subject: "Re: Deal", inReplyTo: "m1@x", references: ["m1@x"], date: NOW + DAY });
        const sentId = (await store.sync.ingest([mine], { applyFilters: false, now: NOW, classifier: null, liveSent: { wanted: true } })).inserted[0]!;
        await store.followups.finish({ messageId: sentId, threadId: p.thread, fromScan: false, rows: [], kept: [], owedKept: [{ id: moved.id, revision: moved.revision }], now: NOW, model: "m", provider: "p", promptVersion: 1, clearGeneration: store.followups.clearGeneration() });
        expect((await store.followups.get(p.row.id))!.state).toBe("open");
      });

      it("what it could act on: its conversation's and its sender's in the account, never one in Spam or Trash, nor later than it", async () => {
        const { store, accountId, got, promised } = await setup();
        const here = await promised({}, { subject: "Here" });
        const there = await promised({}, { subject: "There" });
        const trashed = await promised({}, { subject: "Gone", providerMsgId: "gone" });
        await store.sync.ingest([{ ...trashed.m, isTrash: true, inInbox: false }], { applyFilters: false, now: NOW, classifier: null });
        const next = await got({ date: NOW + 1000 });
        const found = await store.followups.owed.openFor({ threadId: here.thread, accountId, senderKey: alex.email, before: NOW + 1000, limit: 10 });
        expect(found.map((r) => r.id).sort()).toEqual([here.row.id, there.row.id].sort());
        expect(await store.followups.owed.openFor({ threadId: here.thread, accountId, senderKey: bea.email, before: NOW + 1000, limit: 10 })).toEqual([expect.objectContaining({ id: here.row.id })]);
        expect(await store.followups.owed.openFor({ threadId: next.thread, accountId, senderKey: alex.email, before: NOW - 120_000, limit: 10 })).toEqual([]);
      });
    });

    describe("the Inbox's top and the bound", () => {
      it("a firm promise of theirs comes due on top; a tentative one, or one from a check, off it", async () => {
        const { store, got, owed, finish } = await setup();
        const a = await got();
        await finish(a.id, a.thread, { rows: [owed({ dueAt: NOW - 1 }), owed({ item: 201, dueAt: NOW - 1, firm: false })] });
        const b = await got();
        await store.followups.owed.marks.queueScan([b.id], NOW);
        await finish(b.id, b.thread, { rows: [owed({ dueAt: NOW - 1 })], fromScan: true });
        const due = await store.followups.makeDue(NOW);
        expect(due.map((r) => [r.item, r.firm, r.fromScan, r.inboxState]).sort()).toEqual([[200, true, false, "onTop"], [200, true, true, "none"], [201, false, false, "none"]].sort());
      });

      it("at the bound a new row takes the place of the oldest worth less; a promise of yours is never taken, and its Undo always fits; a wait's Undo with no room is refused", async () => {
        const { store, accountId, got, owed, finish } = await setup();
        const sent = msg({ accountId, from: me, to: [alex], isSent: true, inInbox: false, providerMsgId: "cap", rfcMessageId: "cap@x", date: NOW - 60_000 });
        const s = (await store.sync.ingest([sent], { applyFilters: false, now: NOW, classifier: null, liveSent: { wanted: true } })).inserted[0]!;
        const thread = await threadOf(store, "cap");
        const wait = (item: number): FollowupWrite => ({ kind: "awaiting", item, text: "", quote: null, personName: "Alex", personEmail: alex.email, dueAt: NOW + 5 * DAY, dated: false });
        const mine: FollowupWrite = { kind: "promise", item: 0, text: "send the deck", quote: "I'll send the deck", personName: "Alex", personEmail: alex.email, dueAt: NOW + DAY, dated: true };
        const sentFinish = (rows: FollowupWrite[]): Promise<unknown> => store.followups.finish({ messageId: s, threadId: thread, fromScan: false, rows, kept: [], now: NOW, model: "m", provider: "p", promptVersion: 1, clearGeneration: store.followups.clearGeneration() } satisfies FollowupFinish);
        await sentFinish([mine, ...Array.from({ length: FOLLOWUPS_ACTIVE_MAX - 2 }, (_, i) => wait(AWAITING_ITEM + 1000 + i))]);
        // one place left: a tentative undated promise of theirs takes it
        const a = await got();
        await finish(a.id, a.thread, { rows: [owed({ dated: false, dueDay: null, firm: false })] });
        const count = async () => (await store.followups.active()).length;
        expect(await count()).toBe(FOLLOWUPS_ACTIVE_MAX);
        // full: another tentative one (worth nothing) isn't added
        const b = await got();
        await finish(b.id, b.thread, { rows: [owed({ dated: false, dueDay: null, firm: false })] });
        expect((await store.followups.active()).filter((r) => r.kind === "theirs")).toHaveLength(1);
        // a firm dated one takes the tentative one's place (the least worth first)
        const c = await got();
        await finish(c.id, c.thread, { rows: [owed()] });
        const theirs = (await store.followups.active()).filter((r) => r.kind === "theirs");
        expect(theirs.map((r) => r.firm)).toEqual([true]);
        expect(await count()).toBe(FOLLOWUPS_ACTIVE_MAX);
        expect((await store.followups.active()).some((r) => r.kind === "promise")).toBe(true);
        // a promise of yours always fits: Done, a new row in its place, Undo takes the least worth's place
        const yours = (await store.followups.active()).find((r) => r.kind === "promise")!;
        const doneYours = (await store.followups.update(yours.id, yours.revision, { state: "done", closedReason: "user", closedAt: NOW }))!;
        const e = await got();
        await finish(e.id, e.thread, { rows: [owed()] });
        expect(await count()).toBe(FOLLOWUPS_ACTIVE_MAX);
        expect(await store.followups.restore([{ snapshot: doneYours, expectRevision: doneYours.revision + 1 }])).toBe(1);
        expect((await store.followups.get(yours.id))!.state).toBe("open");
        expect(await count()).toBe(FOLLOWUPS_ACTIVE_MAX);
        // Done on a wait, a new row in its place, then Undo: no room for it (nothing worth less than a wait), refused
        const row = (await store.followups.active()).filter((r) => r.kind === "awaiting").sort((a, b) => a.id - b.id)[0]!;
        const before = (await store.followups.update(row.id, row.revision, { state: "done", closedReason: "user", closedAt: NOW }))!;
        const d = await got();
        await finish(d.id, d.thread, { rows: [owed()] });
        expect(await count()).toBe(FOLLOWUPS_ACTIVE_MAX);
        expect(await store.followups.restore([{ snapshot: before, expectRevision: before.revision + 1 }])).toBe(0);
        expect(await count()).toBe(FOLLOWUPS_ACTIVE_MAX);
        expect((await store.followups.get(row.id))!.state).toBe("done");
      });
    });

    describe("from your own mail", () => {
      it("a promise of theirs your mail records, and one your mail says arrived, only from a send that's yours for certain", async () => {
        const { store, accountId, promised } = await setup();
        const send = async (over: Partial<IncomingMessage>) => {
          const m = msg({ accountId, from: me, to: [alex], isSent: true, inInbox: false, date: NOW - 1000, ...over });
          const id = (await store.sync.ingest([m], { applyFilters: false, now: NOW, classifier: null, liveSent: { wanted: true } })).inserted[0]!;
          return { id, thread: await threadOf(store, m.providerMsgId!) };
        };
        const theirs: FollowupWrite = { kind: "theirs", item: 200, text: "send you the contract", quote: "you'll send the contract Thursday", personName: "Alex", personEmail: alex.email, dueAt: NOW + 2 * DAY, dated: true, dueDay: "2026-11-06", firm: true };
        const sentFinish = (s: { id: number; thread: number }, over: Partial<FollowupFinish>) => store.followups.finish({ messageId: s.id, threadId: s.thread, fromScan: false, rows: [], kept: [], now: NOW, model: "m", provider: "p", promptVersion: 1, clearGeneration: store.followups.clearGeneration(), ...over });
        const forged = await send({ providerMsgId: "forged" });
        await sentFinish(forged, { rows: [theirs] });
        expect(await store.followups.ofThread(forged.thread)).toEqual([]);
        const trusted = await send({ providerMsgId: "trusted", gmailLabels: ["SENT"] });
        await sentFinish(trusted, { rows: [theirs] });
        expect(await store.followups.ofThread(trusted.thread)).toEqual([expect.objectContaining({ kind: "theirs", personKey: alex.email, dueDay: "2026-11-06", firm: true })]);
        // "got it, thanks": closes it, only from a trusted send, at the revision shown
        const p = await promised({}, { subject: "Deck", providerMsgId: "deck", rfcMessageId: "deck@x" });
        const thanksForged = await send({ providerMsgId: "t1", subject: "Re: Deck", inReplyTo: "deck@x", references: ["deck@x"], date: NOW });
        await sentFinish(thanksForged, { owedKept: [{ id: p.row.id, revision: p.row.revision }] });
        expect((await store.followups.get(p.row.id))!.state).toBe("open");
        const thanks = await send({ providerMsgId: "t2", subject: "Re: Deck", inReplyTo: "deck@x", references: ["deck@x"], gmailLabels: ["SENT"], date: NOW });
        expect(thanks.thread).toBe(p.thread);
        await sentFinish(thanks, { owedKept: [{ id: p.row.id, revision: p.row.revision }] });
        expect(await store.followups.get(p.row.id)).toMatchObject({ state: "done", closedReason: "kept", settledBy: thanks.id });
      });
    });

    it("Clear AI data empties the owed marks with the rows", async () => {
      const { store, got, promised } = await setup();
      await promised();
      await got();
      await store.followups.clear();
      expect(await store.followups.owed.marks.count()).toBe(0);
      expect(await store.followups.active()).toEqual([]);
    });
  });
}
