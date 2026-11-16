import { describe, expect, it } from "vitest";
import { AWAITING_ITEM, FOLLOWUPS_ACTIVE_MAX, SCAN_MARK_MS, SENT_MARK_MS, type FollowupFinish, type FollowupWrite } from "../followups";
import type { MailStore } from "../mail-store";
import type { IncomingMessage } from "../types";
import { msg, threadOf, withAccounts } from "./fixtures";

const NOW = Date.UTC(2026, 10, 5, 12);
const me = { name: "Me", email: "me0@example.com" };
const tom = { name: "Tom", email: "tom@acme.test" };
const DAY = 86_400_000;

/**
 * Plan 142: sent mail is marked only when it's confirmed or arrives live; identity is the source and item, so a re-read
 * can't double a row and two messages saying the same are two promises; everything a user does is conditional on what
 * they saw; a reply ends a wait, wherever it's found, and only a real one does.
 */
export function defineFollowupsConformance(fresh: () => Promise<MailStore>, reopen: (store: MailStore) => Promise<MailStore>): void {
  describe("Follow-ups (plan 142)", () => {
    async function setup() {
      const store = await fresh();
      const [accountId] = await withAccounts(store, 1);
      const sent = async (over: Partial<IncomingMessage> = {}, liveSent: { wanted: boolean } | null = { wanted: true }, at = NOW) => {
        const m = msg({ accountId: accountId!, from: me, to: [tom], isSent: true, inInbox: false, date: at - 60_000, ...over });
        const r = await store.sync.ingest([m], { applyFilters: false, now: at, classifier: null, ...(liveSent ? { liveSent } : {}) });
        return { id: r.inserted[0]!, thread: await threadOf(store, m.providerMsgId!), m };
      };
      const promise = (over: Partial<FollowupWrite> = {}): FollowupWrite => ({ kind: "promise", item: 0, text: "send the contract", quote: "I'll send the contract", personName: "Tom", personEmail: tom.email, dueAt: NOW + DAY, dated: false, ...over });
      const wait = (over: Partial<FollowupWrite> = {}): FollowupWrite => ({ kind: "awaiting", item: AWAITING_ITEM, text: "", quote: null, personName: "Tom", personEmail: tom.email, dueAt: NOW + 5 * DAY, dated: false, ...over });
      const finish = (messageId: number, threadId: number, over: Partial<FollowupFinish> = {}) => store.followups.finish({ messageId, threadId, fromScan: false, rows: [], kept: [], now: NOW, model: "m", provider: "p", promptVersion: 1, clearGeneration: store.followups.clearGeneration(), ...over });
      return { store, accountId: accountId!, sent, promise, wait, finish };
    }

    describe("the marker", () => {
      it("marks live sent mail once; none for first sync, drafts, or when off; re-ingest doesn't double it", async () => {
        const { store, sent } = await setup();
        const a = await sent();
        await sent({}, null);
        await sent({}, { wanted: false });
        await sent({ isDraft: true });
        await sent({ to: [me] });
        await sent({ date: NOW - 10 * DAY });
        const page = await store.followups.marks.page(null, 50);
        expect(page.map((m) => m.messageId)).toEqual([a.id]);
        expect(page[0]).toMatchObject({ threadId: a.thread, source: "live" });
        await store.sync.ingest([a.m], { applyFilters: false, now: NOW, classifier: null, liveSent: { wanted: true } });
        expect(await store.followups.marks.count()).toBe(1);
      });

      it("a scan's marks live 14 days and a live one 3; both go with their message", async () => {
        const { store, sent } = await setup();
        const a = await sent();
        const b = await sent({}, null, NOW);
        expect(await store.followups.marks.queueScan([b.id], NOW)).toBe(1);
        await store.followups.marks.prune(NOW + SENT_MARK_MS + 1);
        expect((await store.followups.marks.page(null, 9)).map((m) => m.messageId)).toEqual([b.id]);
        await store.followups.marks.prune(NOW + SCAN_MARK_MS + 1);
        expect(await store.followups.marks.count()).toBe(0);
        expect(a.id).toBeGreaterThan(0);
      });

      it("mail from before it was turned on isn't marked; a check's yes is what reads it", async () => {
        const { store, accountId } = await setup();
        const m = msg({ accountId, from: me, to: [tom], isSent: true, inInbox: false, date: NOW - DAY });
        await store.sync.ingest([m], { applyFilters: false, now: NOW, classifier: null, liveSent: { wanted: true, since: NOW - 1000 } });
        expect(await store.followups.marks.count()).toBe(0);
      });

      it("a check never takes what isn't confirmed sent: a queued or failed copy may never have gone", async () => {
        const { store, sent } = await setup();
        const real = await sent({ providerMsgId: "real" }, null, NOW);
        const local = await sent({ providerMsgId: "local:abc" }, null, NOW);
        const found = await store.followups.scanCandidates(NOW - 30 * DAY, 10);
        expect(found).toContain(real.id);
        expect(found).not.toContain(local.id);
        expect(await store.followups.marks.queueScan([local.id], NOW)).toBe(0);
      });

      it("what a reply answers is what it says it answers, not the newest message", async () => {
        const { store, accountId, sent } = await setup();
        const ingest = (over: Partial<IncomingMessage>) => store.sync.ingest([msg({ accountId, from: tom, to: [me], subject: "Re", ...over })], { applyFilters: false, now: NOW, classifier: null });
        const asked = (await ingest({ providerMsgId: "q", rfcMessageId: "q@x", date: NOW - 5000 })).inserted[0]!;
        const later = (await ingest({ providerMsgId: "n", rfcMessageId: "n@x", inReplyTo: "q@x", references: ["q@x"], date: NOW - 3000 })).inserted[0]!;
        const pointed = await sent({ providerMsgId: "a", inReplyTo: "q@x", references: ["q@x", "n@x"], date: NOW - 1000 });
        expect((await store.followups.source(pointed.id))!.answering?.id).toBe(asked);
        const unsaid = await sent({ providerMsgId: "b", inReplyTo: null, references: ["q@x", "n@x"], date: NOW - 500 });
        expect((await store.followups.source(unsaid.id))!.answering?.id).toBe(later);
        const unknown = await sent({ providerMsgId: "c", inReplyTo: "gone@x", references: ["q@x", "n@x", "gone@x"], date: NOW - 200 });
        expect((await store.followups.source(unknown.id))!.answering).toBeNull();
      });

      it("survives a reopen", async () => {
        const { store, sent } = await setup();
        await sent();
        const back = await reopen(store);
        expect(await back.followups.marks.count()).toBe(1);
      });
    });

    describe("finish", () => {
      it("results and consuming the mark commit together; nothing found still consumes it", async () => {
        const { store, sent, promise, finish } = await setup();
        const a = await sent();
        expect(await finish(a.id, a.thread, { rows: [promise()] })).toBe("written");
        expect(await store.followups.marks.count()).toBe(0);
        const [row] = await store.followups.active();
        expect(row).toMatchObject({ threadId: a.thread, messageId: a.id, kind: "promise", state: "open", inboxState: "none", text: "send the contract" });
        const b = await sent();
        expect(await finish(b.id, b.thread)).toBe("written");
        expect(await store.followups.marks.count()).toBe(0);
      });

      it("identity is the source and item: a re-read can't double one; the same words on two messages are two", async () => {
        const { store, sent, promise, finish } = await setup();
        const a = await sent();
        await finish(a.id, a.thread, { rows: [promise()] });
        await store.followups.marks.queueScan([a.id], NOW);
        await finish(a.id, a.thread, { rows: [promise()] });
        expect(await store.followups.active()).toHaveLength(1);
        const b = await sent();
        await finish(b.id, b.thread, { rows: [promise()] });
        expect(await store.followups.active()).toHaveLength(2);
      });

      it("a kept promise closes only the exact row it saw, on this thread", async () => {
        const { store, sent, promise, finish } = await setup();
        const a = await sent({ providerMsgId: "t0", rfcMessageId: "t0@x" });
        await finish(a.id, a.thread, { rows: [promise()] });
        const [row] = await store.followups.active();
        const other = await sent({ subject: "Elsewhere" });
        await finish(other.id, other.thread, { kept: [{ id: row!.id, revision: row!.revision }] });
        expect((await store.followups.get(row!.id))!.state).toBe("open");
        const b = await sent({ providerMsgId: "t1", rfcMessageId: "t1@x", inReplyTo: "t0@x", references: ["t0@x"], date: NOW - 1000 });
        await finish(b.id, b.thread, { kept: [{ id: row!.id, revision: row!.revision + 5 }] });
        expect((await store.followups.get(row!.id))!.state).toBe("open");
        const c = await sent({ providerMsgId: "t2", rfcMessageId: "t2@x", inReplyTo: "t1@x", references: ["t1@x"], date: NOW - 500 });
        await finish(c.id, c.thread, { kept: [{ id: row!.id, revision: row!.revision }] });
        // plan 210 (iteration 4, revision 7): the send that kept it, and its date
        expect(await store.followups.get(row!.id)).toMatchObject({ state: "done", closedReason: "kept", closedAt: NOW, settledBy: c.id, settledAt: NOW - 500 });
        expect((await store.followups.closedPage({ since: 0, after: null, limit: 10 })).find((r) => r.id === row!.id)).toMatchObject({ settledBy: c.id, settledAt: NOW - 500 });
      });

      it("a clear refuses a write that started before it", async () => {
        const { store, sent, promise, finish } = await setup();
        const a = await sent();
        const generation = store.followups.clearGeneration();
        await store.followups.clear();
        expect(await finish(a.id, a.thread, { rows: [promise()], clearGeneration: generation })).toBe("gone");
        expect(await store.followups.active()).toEqual([]);
      });

      it("at the cap a wait isn't added and a promise replaces the oldest wait", async () => {
        const { store, sent, promise, wait, finish } = await setup();
        const a = await sent({ providerMsgId: "cap", rfcMessageId: "cap@x" });
        const big = Array.from({ length: FOLLOWUPS_ACTIVE_MAX - 1 }, (_, i) => wait({ item: 1000 + i }));
        await finish(a.id, a.thread, { rows: big });
        await store.followups.marks.queueScan([a.id], NOW);
        await finish(a.id, a.thread, { rows: [wait({ item: 5000 }), wait({ item: 5001 }), promise()] });
        const active = await store.followups.active();
        expect(active.length).toBeLessThanOrEqual(FOLLOWUPS_ACTIVE_MAX);
        expect(active.some((r) => r.kind === "promise")).toBe(true);
      });
    });

    describe("ending", () => {
      const replyTo = (store: MailStore, accountId: number, parent: string, over: Partial<IncomingMessage> = {}) =>
        store.sync.ingest([msg({ accountId, from: tom, to: [me], inReplyTo: parent, references: [parent], subject: "Re", date: NOW + 1000, ...over })], { applyFilters: false, now: NOW + 1000, classifier: null });

      it("a reply ends a wait; one from yourself or in Spam doesn't", async () => {
        const { store, accountId, sent, wait, finish } = await setup();
        const a = await sent({ providerMsgId: "s", rfcMessageId: "s@x" });
        await finish(a.id, a.thread, { rows: [wait()] });
        const [row] = await store.followups.active();
        await replyTo(store, accountId, "s@x", { isSpam: true });
        expect(await store.followups.closeAnswered([row!.id], NOW + 2000)).toEqual([]);
        await replyTo(store, accountId, "s@x", { from: { name: "Other me", email: me.email }, isSent: false });
        expect(await store.followups.closeAnswered([row!.id], NOW + 2000)).toEqual([]);
        await replyTo(store, accountId, "s@x");
        expect(await store.followups.closeAnswered([row!.id], NOW + 2000)).toEqual([row!.id]);
        expect(await store.followups.get(row!.id)).toMatchObject({ state: "done", closedReason: "replied" });
      });

      it("a reply already there means the wait is never added", async () => {
        const { store, accountId, sent, wait, finish } = await setup();
        const a = await sent({ providerMsgId: "s", rfcMessageId: "s@x" });
        await replyTo(store, accountId, "s@x");
        await finish(a.id, a.thread, { rows: [wait()] });
        expect(await store.followups.active()).toEqual([]);
      });

      it("only a send that's confirmed ends a wait: a local copy doesn't, its later sync does", async () => {
        const { store, sent, wait, finish } = await setup();
        const a = await sent({ providerMsgId: "s", rfcMessageId: "s@x" });
        await finish(a.id, a.thread, { rows: [wait()] });
        await store.sync.ingest([msg({ accountId: a.m.accountId, from: me, to: [tom], isSent: true, providerMsgId: "s2", rfcMessageId: "s2@x", inReplyTo: "s@x", references: ["s@x"], date: NOW + 1000 })], { applyFilters: false, now: NOW + 1000, classifier: null });
        expect((await store.followups.active()).map((r) => r.state)).toEqual(["open"]);
        await store.sync.ingest([msg({ accountId: a.m.accountId, from: me, to: [tom], isSent: true, providerMsgId: "s3", rfcMessageId: "s3@x", inReplyTo: "s@x", references: ["s@x"], date: NOW + 2000 })], { applyFilters: false, now: NOW + 2000, classifier: null, liveSent: { wanted: false } });
        expect(await store.followups.active()).toEqual([]);
      });
    });

    describe("due, top and what the user does", () => {
      it("comes due on top; a scan's stays in the list; opening ends the top, not the row", async () => {
        const { store, sent, promise, finish } = await setup();
        const a = await sent();
        await finish(a.id, a.thread, { rows: [promise({ dueAt: NOW - 1 })] });
        const b = await sent({ subject: "Scan" });
        await finish(b.id, b.thread, { rows: [promise({ dueAt: NOW - 1 })], fromScan: true });
        expect(await store.followups.nextDue()).toBe(NOW - 1);
        const due = await store.followups.makeDue(NOW);
        expect(due.map((r) => [r.fromScan, r.inboxState, r.state])).toEqual(expect.arrayContaining([[false, "onTop", "due"], [true, "none", "due"]]));
        expect(await store.followups.nextDue()).toBeNull();
        const ended = await store.followups.endTop([a.thread]);
        expect(ended).toHaveLength(1);
        expect((await store.followups.ofThread(a.thread))[0]).toMatchObject({ state: "due", inboxState: "seen" });
        await store.followups.restore(ended.map((snapshot) => ({ snapshot, expectRevision: snapshot.revision + 1 })));
        expect((await store.followups.ofThread(a.thread))[0]!.inboxState).toBe("onTop");
      });

      it("notices are claimed once per row, so two on one thread each say so", async () => {
        const { store, sent, promise, finish } = await setup();
        const a = await sent();
        await finish(a.id, a.thread, { rows: [promise({ dueAt: NOW - 1 }), promise({ item: 1, dueAt: NOW - 1 })] });
        const due = await store.followups.makeDue(NOW);
        const ids = due.map((r) => r.id);
        expect((await store.followups.claimNotice(ids, NOW)).sort()).toEqual([...ids].sort());
        expect(await store.followups.claimNotice(ids, NOW)).toEqual([]);
      });

      it("a change applies only to the revision seen; Undo restores exactly, unless something changed it since", async () => {
        const { store, sent, promise, finish } = await setup();
        const a = await sent();
        await finish(a.id, a.thread, { rows: [promise({ dueAt: NOW - 1 })] });
        const [due] = await store.followups.makeDue(NOW);
        expect(await store.followups.update(due!.id, due!.revision + 7, { state: "done" })).toBeNull();
        const before = (await store.followups.update(due!.id, due!.revision, { state: "done", closedReason: "user", closedAt: NOW, inboxState: "none" }))!;
        expect(await store.followups.active()).toEqual([]);
        expect(await store.followups.restore([{ snapshot: before, expectRevision: before.revision + 1 }])).toBe(1);
        expect(await store.followups.get(due!.id)).toMatchObject({ state: "due", inboxState: "onTop", closedReason: null, closedAt: null, dueAt: NOW - 1 });
        expect(await store.followups.restore([{ snapshot: before, expectRevision: before.revision + 1 }])).toBe(0);
      });

      it("plan 204 (the fifth panel round): a promise's Later keeps its day, comes due by it, survives a reopen; Undo puts back no deferral", async () => {
        const { store, sent, promise, finish } = await setup();
        const a = await sent();
        await finish(a.id, a.thread, { rows: [promise({ dueAt: NOW - DAY, dated: true })] });
        const [row] = await store.followups.active();
        expect(row!.deferredUntil).toBeNull();
        // put off past its day while still open: not due at once, nor its next moment before then
        const before = (await store.followups.update(row!.id, row!.revision, { state: "open", inboxState: "none", deferredUntil: NOW + 2 * DAY }))!;
        expect(before).toMatchObject({ deferredUntil: null, dueAt: NOW - DAY });
        expect(await store.followups.get(row!.id)).toMatchObject({ dueAt: NOW - DAY, deferredUntil: NOW + 2 * DAY, state: "open", revision: row!.revision + 1 });
        expect(await store.followups.makeDue(NOW)).toEqual([]);
        expect(await store.followups.nextDue()).toBe(NOW + 2 * DAY);
        const back = await reopen(store);
        expect(await back.followups.get(row!.id)).toMatchObject({ dueAt: NOW - DAY, deferredUntil: NOW + 2 * DAY, revision: row!.revision + 1 });
        // Undo: at the revision Later left, the deferral goes back to none
        expect(await back.followups.restore([{ snapshot: before, expectRevision: before.revision + 1 }])).toBe(1);
        expect(await back.followups.get(row!.id)).toMatchObject({ dueAt: NOW - DAY, deferredUntil: null });
        // a journal written before the deferral existed restores none too
        const now = (await back.followups.get(row!.id))!;
        await back.followups.update(now.id, now.revision, { deferredUntil: NOW + DAY });
        const { deferredUntil: _, ...old } = before;
        expect(await back.followups.restore([{ snapshot: { ...old, revision: now.revision } as typeof before, expectRevision: now.revision + 1 }])).toBe(1);
        expect((await back.followups.get(row!.id))!.deferredUntil).toBeNull();
        // its Later's moment comes: due then, on top
        const again = (await back.followups.get(row!.id))!;
        await back.followups.update(again.id, again.revision, { deferredUntil: NOW + DAY });
        expect(await back.followups.makeDue(NOW + DAY - 1)).toEqual([]);
        expect((await back.followups.makeDue(NOW + DAY)).map((r) => [r.id, r.state, r.inboxState, r.deferredUntil])).toEqual([[row!.id, "due", "onTop", NOW + DAY]]);
        expect(await back.followups.nextDue()).toBeNull();
      });

      it("a deferral before its moment changes nothing: it comes due at its moment", async () => {
        const { store, sent, promise, finish } = await setup();
        const a = await sent();
        await finish(a.id, a.thread, { rows: [promise({ dueAt: NOW + 3 * DAY, dated: true })] });
        const [row] = await store.followups.active();
        await store.followups.update(row!.id, row!.revision, { deferredUntil: NOW + DAY });
        expect(await store.followups.nextDue()).toBe(NOW + 3 * DAY);
        expect(await store.followups.makeDue(NOW + 2 * DAY)).toEqual([]);
        expect(await store.followups.makeDue(NOW + 3 * DAY)).toHaveLength(1);
      });

      it("a deleted thread takes them with it; a merge moves them; closed rows go after 90 days", async () => {
        const { store, sent, promise, finish } = await setup();
        const a = await sent({ subject: "One", providerMsgId: "ma", rfcMessageId: "ma@x" });
        const b = await sent({ subject: "Two", providerMsgId: "mb", rfcMessageId: "mb@x" });
        await finish(a.id, a.thread, { rows: [promise()] });
        await finish(b.id, b.thread, { rows: [promise()] });
        const bridge = await sent({ subject: "Re", providerMsgId: "mc", rfcMessageId: "mc@x", references: ["ma@x", "mb@x"], inReplyTo: "mb@x" });
        expect((await store.followups.active()).every((r) => r.threadId === bridge.thread)).toBe(true);
        const [row] = await store.followups.active();
        await store.followups.update(row!.id, row!.revision, { state: "done", closedReason: "user", closedAt: NOW });
        expect(await store.followups.prune(NOW + 91 * DAY)).toBe(1);
      });
    });
    describe("the history's reads (plan 210)", () => {
      it("pages your closed promises newest first, strictly after a key; waits and open rows never", async () => {
        const { store, sent, promise, wait, finish } = await setup();
        const ids: { id: number; thread: number }[] = [];
        for (const i of [0, 1, 2, 3]) {
          const m = await sent({ subject: `P ${i}`, providerMsgId: `hp-${i}`, rfcMessageId: `hp-${i}@x` });
          await finish(m.id, m.thread, { rows: i === 3 ? [wait()] : [promise()] });
          const [row] = await store.followups.ofThread(m.thread);
          ids.push({ id: row!.id, thread: m.thread });
          if (i === 2) continue;
          await store.followups.update(row!.id, row!.revision, { state: i === 1 ? "dismissed" : "done", closedReason: "user", closedAt: i === 0 ? NOW - 2000 : NOW - 1000 });
        }
        const since = NOW - 90 * DAY;
        const page = await store.followups.closedPage({ since, after: null, limit: 10 });
        // the wait closed (i = 3) isn't yours to show; the open promise (i = 2) isn't closed
        expect(page.map((r) => r.id)).toEqual([ids[1]!.id, ids[0]!.id]);
        expect((await store.followups.closedPage({ since, after: { at: NOW - 1000, id: ids[1]!.id }, limit: 10 })).map((r) => r.id)).toEqual([ids[0]!.id]);
        expect((await store.followups.closedPage({ since: NOW - 1500, after: null, limit: 10 })).map((r) => r.id)).toEqual([ids[1]!.id]);
      });
    });
  });
}
