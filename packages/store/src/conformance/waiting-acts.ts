import { FACTS_WINDOW } from "@terno/core";
import { describe, expect, it } from "vitest";
import type { MailStore } from "../mail-store";
import type { IncomingMessage } from "../types";
import { WAITING_CLOSED, WAITING_MOMENTS_MAX } from "../waiting-acts";
import { msg, threadOf, withAccounts } from "./fixtures";

const NOW = Date.UTC(2026, 10, 17, 12);
const DAY = 86_400_000;
const me = { name: "Me", email: "me0@example.com" };

/**
 * Plan 215: Done ("no reply needed") and Later on a conversation waiting on you, the same in both stores: the act on the
 * message the facts judge waiting, at the fact and revision seen; Done read by the facts (the Inbox's Waiting filter and
 * count, search, Needs you); Later read by its own; exact Undo; the dated reader following them; Earlier's page.
 */
export function defineWaitingActsConformance(fresh: () => Promise<MailStore>): void {
  describe("Done and Later on a conversation waiting on you (plan 215)", () => {
    async function setup() {
      const store = await fresh();
      const [accountId] = await withAccounts(store, 1);
      let seq = 0;
      /** their message after one of yours: a conversation you're in, waiting on you */
      const talk = async (name: string, date: number, over: Partial<IncomingMessage> = {}) => {
        const key = `conv-${name}-${seq++}`;
        const them = { name, email: `${name.toLowerCase()}@people.test` };
        await store.sync.ingest([msg({ accountId: accountId!, date: date - 500, providerMsgId: `${key}-out`, rfcMessageId: `${key}-out@t`, providerThreadId: key, from: me, to: [them], isSent: true, isRead: true, subject: `About ${name}` })], { applyFilters: false, now: NOW, classifier: null });
        const r = await store.sync.ingest([msg({ accountId: accountId!, date, providerMsgId: `${key}-in`, providerThreadId: key, from: them, to: [me], inReplyTo: `${key}-out@t`, references: [`${key}-out@t`], subject: `Re: About ${name}`, ...over })], { applyFilters: false, now: NOW, classifier: null });
        return { thread: await threadOf(store, `${key}-in`), message: r.inserted[0]!, key, them };
      };
      /** another message from them in the same conversation */
      const again = async (c: { key: string; them: { name: string; email: string } }, date: number) => {
        const r = await store.sync.ingest([msg({ accountId: accountId!, date, providerMsgId: `${c.key}-again-${seq++}`, providerThreadId: c.key, from: c.them, to: [me], subject: `Re: About ${c.them.name}` })], { applyFilters: false, now: NOW, classifier: null });
        return r.inserted[0]!;
      };
      const since = async (thread: number) => (await store.threads.summaries([thread]))[0]!.waitingSince ?? null;
      const waitingIds = async () => (await store.threads.list({ view: "inbox", filter: "waiting", now: NOW, limit: 50 })).items.map((t) => t.id);
      const page = async () => (await store.today.waitingPage({ now: NOW, after: null, limit: 50 })).map((p) => p.id);
      /** a waiting row's facts, as the list (messages) or the count reads them */
      const rows = async (thread: number, at: number, messages = true, now = NOW) => (await store.today.waiting.rows([{ threadId: thread, since: at }], now, { messages })).get(thread);
      return { store, accountId: accountId!, talk, again, since, waitingIds, page, rows };
    }

    it("Done clears the fact in the same write: the Inbox's filter and count, search, Needs you agree; Undo puts it back exactly", async () => {
      const { store, talk, since, waitingIds, page, rows } = await setup();
      const ana = await talk("Ana", NOW - DAY);
      const bea = await talk("Bea", NOW - 2 * DAY);
      expect((await store.today.waitingPage({ now: NOW, after: null, limit: 5 })).map((p) => [p.id, p.waitingSince])).toEqual([[ana.thread, NOW - DAY], [bea.thread, NOW - 2 * DAY]]);
      expect((await store.threads.counts(NOW)).inboxWaiting).toBe(2);
      // at a date or a revision that isn't what's there: nothing written
      expect(await store.today.waiting.act({ threadId: ana.thread, since: NOW - 2 * DAY, message: ana.message, rev: 0, state: "done", until: null, now: NOW })).toBeNull();
      expect(await store.today.waiting.act({ threadId: ana.thread, since: NOW - DAY, message: ana.message, rev: 1, state: "done", until: null, now: NOW })).toBeNull();
      const done = await store.today.waiting.act({ threadId: ana.thread, since: NOW - DAY, message: ana.message, rev: 0, state: "done", until: null, now: NOW });
      expect(done).toEqual({ messageId: ana.message, threadId: ana.thread, rev: 1, before: null, items: [] });
      expect(await since(ana.thread)).toBeNull();
      expect(await waitingIds()).toEqual([bea.thread]);
      expect((await store.threads.counts(NOW)).inboxWaiting).toBe(1);
      expect(await page()).toEqual([bea.thread]);
      expect((await store.threads.searchText({ query: "About", threadFilter: "waiting", limit: 10, now: NOW })).items.map((t) => t.id)).toEqual([bea.thread]);
      const docs = new Map((await store.debug.snapshot()).search.threads.map((d) => [d.threadId, d]));
      expect(docs.get(ana.thread)?.waitingSince ?? null).toBeNull();
      // a second act on what it showed is stale (Later on a row done meanwhile too)
      expect(await store.today.waiting.act({ threadId: ana.thread, since: NOW - DAY, message: ana.message, rev: 0, state: "later", until: NOW + DAY, now: NOW })).toBeNull();
      expect(await store.today.waiting.restore(done!)).toBe(ana.thread);
      expect(await since(ana.thread)).toBe(NOW - DAY);
      expect(await waitingIds()).toEqual([ana.thread, bea.thread]);
      expect((await store.threads.counts(NOW)).inboxWaiting).toBe(2);
      expect(await rows(ana.thread, NOW - DAY)).toEqual({ message: ana.message, rev: 0, until: null });
      // its Undo once more: the record isn't the act's any more
      expect(await store.today.waiting.restore(done!)).toBeNull();
    });

    it("a newer message from them waits again by itself; the record stays with its message and goes with it", async () => {
      const { store, talk, again, since, page, rows } = await setup();
      const ana = await talk("Ana", NOW - 2 * DAY);
      await store.today.waiting.act({ threadId: ana.thread, since: NOW - 2 * DAY, message: ana.message, rev: 0, state: "done", until: null, now: NOW - DAY });
      expect(await since(ana.thread)).toBeNull();
      await again(ana, NOW - 1000);
      expect(await since(ana.thread)).toBe(NOW - 1000);
      expect(await page()).toEqual([ana.thread]);
      // the new message has no record: the row is drawn for it at revision 0, and its Done is its own
      const fresh = await rows(ana.thread, NOW - 1000);
      expect([fresh?.message === ana.message, fresh?.rev]).toEqual([false, 0]);
      expect((await store.today.waiting.donePage({ since: 0, after: null, limit: 10 })).map((d) => d.messageId)).toEqual([ana.message]);
      await store.sync.remove([ana.message]);
      expect(await store.today.waiting.donePage({ since: 0, after: null, limit: 10 })).toEqual([]);
    });

    it("Later leaves the fact as it is (the Inbox keeps it), is read by its row, moves, gives way to Done; a newer message isn't put off", async () => {
      const { store, talk, again, since, waitingIds, page, rows } = await setup();
      const ana = await talk("Ana", NOW - DAY);
      const later = await store.today.waiting.act({ threadId: ana.thread, since: NOW - DAY, message: ana.message, rev: 0, state: "later", until: NOW + DAY, now: NOW });
      expect(later).toEqual({ messageId: ana.message, threadId: ana.thread, rev: 1, before: null, items: [] });
      expect(await since(ana.thread)).toBe(NOW - DAY);
      expect(await waitingIds()).toEqual([ana.thread]);
      // Needs you's walk still has it: What matters places it by its row's deferral (the projection), the same rules holding
      expect(await page()).toEqual([ana.thread]);
      expect(await rows(ana.thread, NOW - DAY)).toEqual({ message: ana.message, rev: 1, until: NOW + DAY });
      // the count's read: the deferral alone; over, none
      expect(await rows(ana.thread, NOW - DAY, false)).toEqual({ message: null, rev: 1, until: NOW + DAY });
      expect(await rows(ana.thread, NOW - DAY, false, NOW + DAY)).toBeUndefined();
      expect(await rows(ana.thread, NOW - DAY, true, NOW + DAY)).toEqual({ message: ana.message, rev: 1, until: null });
      expect(await store.today.waiting.moments(NOW, WAITING_MOMENTS_MAX)).toEqual([NOW + DAY]);
      expect(await store.today.waiting.moments(NOW + DAY, WAITING_MOMENTS_MAX)).toEqual([]);
      // moved: at its revision; its Undo puts the first Later back, whole
      const moved = await store.today.waiting.act({ threadId: ana.thread, since: NOW - DAY, message: ana.message, rev: 1, state: "later", until: NOW + 2 * DAY, now: NOW + 1 });
      expect(moved?.before).toMatchObject({ state: "later", until: NOW + DAY, rev: 1, who: "Ana" });
      expect(await rows(ana.thread, NOW - DAY)).toEqual({ message: ana.message, rev: 2, until: NOW + 2 * DAY });
      expect(await store.today.waiting.restore(moved!)).toBe(ana.thread);
      expect(await rows(ana.thread, NOW - DAY)).toEqual({ message: ana.message, rev: 1, until: NOW + DAY });
      // Done on the deferred row replaces it (one record a message)
      const done = await store.today.waiting.act({ threadId: ana.thread, since: NOW - DAY, message: ana.message, rev: 1, state: "done", until: null, now: NOW + 2 });
      expect(done?.before?.state).toBe("later");
      expect(await store.today.waiting.moments(NOW, 10)).toEqual([]);
      expect(await since(ana.thread)).toBeNull();
      await store.today.waiting.restore(done!);
      // a newer message from them isn't put off
      const newer = await again(ana, NOW - 500);
      expect(await rows(ana.thread, NOW - 500)).toEqual({ message: newer, rev: 0, until: null });
      expect(await rows(ana.thread, NOW - 500, false)).toBeUndefined();
    });

    it("Codex code review 1: an old Undo never erases a newer choice, a Later over kept; a message at the same moment is its own", async () => {
      const { store, talk, again, rows } = await setup();
      const ana = await talk("Ana", NOW - DAY);
      // window A puts it off; its moment comes and goes (kept: a revision never starts again); window B marks it Done
      const a = await store.today.waiting.act({ threadId: ana.thread, since: NOW - DAY, message: ana.message, rev: 0, state: "later", until: NOW + 1000, now: NOW });
      expect(await rows(ana.thread, NOW - DAY, true, NOW + 2000)).toEqual({ message: ana.message, rev: 1, until: null });
      const b = await store.today.waiting.act({ threadId: ana.thread, since: NOW - DAY, message: ana.message, rev: 1, state: "done", until: null, now: NOW + 2000 });
      expect(b?.rev).toBe(2);
      expect(await store.today.waiting.restore(a!)).toBeNull();
      expect((await store.threads.summaries([ana.thread]))[0]!.waitingSince ?? null).toBeNull();
      await store.today.waiting.restore(b!);
      // a newer message of theirs at the very moment of the one drawn: the row drawn for the first is stale, never the new one's
      const twin = await again(ana, NOW - DAY);
      expect(await rows(ana.thread, NOW - DAY)).toEqual({ message: twin, rev: 0, until: null });
      expect(await store.today.waiting.act({ threadId: ana.thread, since: NOW - DAY, message: ana.message, rev: 0, state: "done", until: null, now: NOW })).toBeNull();
      expect(await store.today.waiting.act({ threadId: ana.thread, since: NOW - DAY, message: twin, rev: 0, state: "done", until: null, now: NOW })).toMatchObject({ messageId: twin });
    });

    it("Earlier's page: Done records by their moment, then the message, newest first, paged strictly after a key", async () => {
      const { store, talk } = await setup();
      const convs: Awaited<ReturnType<typeof talk>>[] = [];
      for (const [i, name] of ["Ana", "Bea", "Cleo", "Dia"].entries()) convs.push(await talk(name, NOW - (i + 1) * DAY));
      const at = [NOW, NOW, NOW - 5, NOW];
      for (const [i, c] of convs.entries()) await store.today.waiting.act({ threadId: c.thread, since: NOW - (i + 1) * DAY, message: c.message, rev: 0, state: "done", until: null, now: at[i]! });
      const all = await store.today.waiting.donePage({ since: 0, after: null, limit: 10 });
      const want = convs.map((c, i) => ({ id: c.message, at: at[i]! })).sort((a, b) => b.at - a.at || b.id - a.id);
      expect(all.map((d) => d.messageId)).toEqual(want.map((w) => w.id));
      expect(all[0]).toMatchObject({ threadId: convs.find((c) => c.message === want[0]!.id)!.thread, wrote: true });
      // the row's words at Done: who wrote, and the conversation's subject as the row said it
      const subject = (await store.threads.summaries([convs[0]!.thread]))[0]!.subject;
      expect(all.find((d) => d.messageId === convs[0]!.message)).toMatchObject({ who: "Ana", subject });
      const first = await store.today.waiting.donePage({ since: 0, after: null, limit: 2 });
      const rest = await store.today.waiting.donePage({ since: 0, after: { at: first[1]!.at, id: first[1]!.messageId }, limit: 10 });
      expect([...first, ...rest]).toEqual(all);
      expect((await store.today.waiting.donePage({ since: NOW - 1, after: null, limit: 10 })).length).toBe(3);
    });

    it("the dated reader follows the choice: a request read from a message marked Done is stored closed, one put off is put off", async () => {
      const { store, talk } = await setup();
      const ana = await talk("Ana", NOW - DAY);
      const bea = await talk("Bea", NOW - 2 * DAY);
      await store.today.waiting.act({ threadId: ana.thread, since: NOW - DAY, message: ana.message, rev: 0, state: "done", until: null, now: NOW });
      await store.today.waiting.act({ threadId: bea.thread, since: NOW - 2 * DAY, message: bea.message, rev: 0, state: "later", until: NOW + DAY, now: NOW });
      const ask = { kind: "ask" as const, item: 0, text: "Send the deck", quote: "can you send the deck?", dueDay: "2026-11-18", dueAt: NOW + DAY, timed: false, dated: false, actAt: NOW };
      const pay = { ...ask, kind: "pay" as const, item: 1, text: "Pay the deposit", dated: true };
      for (const c of [ana, bea]) {
        await store.dated.marks.queueScan([c.message], NOW);
        expect(await store.dated.finish({ messageId: c.message, threadId: c.thread, fromScan: true, rows: [ask, pay], settled: [], now: NOW, model: "m", provider: "p", promptVersion: 1, clearGeneration: store.dated.clearGeneration() })).toBe("written");
      }
      const of = async (thread: number) => (await store.dated.ofThread(thread)).map((r) => [r.kind, r.state, r.deferredUntil]);
      // the open ones: Ana's bill only (her ask is closed with the Done); Bea's ask put off to the Later's moment
      expect(await of(ana.thread)).toEqual([["pay", "open", null]]);
      expect((await of(bea.thread)).sort()).toEqual([["ask", "open", NOW + DAY], ["pay", "open", null]].sort());
      const closed = (await store.dated.closedPage({ since: 0, after: null, limit: 10 })).find((r) => r.threadId === ana.thread)!;
      expect([closed.kind, closed.state, closed.closedReason]).toEqual(["ask", "dismissed", WAITING_CLOSED]);
    });

    it("Codex code review 1: a request the reader read before the act follows it too, and its Undo puts it back", async () => {
      const { store, talk } = await setup();
      const ana = await talk("Ana", NOW - DAY);
      const ask = { kind: "ask" as const, item: 0, text: "Send the deck", quote: "can you send the deck?", dueDay: "2026-11-18", dueAt: NOW + DAY, timed: false, dated: false, actAt: NOW };
      await store.dated.marks.queueScan([ana.message], NOW);
      await store.dated.finish({ messageId: ana.message, threadId: ana.thread, fromScan: true, rows: [ask], settled: [], now: NOW, model: "m", provider: "p", promptVersion: 1, clearGeneration: store.dated.clearGeneration() });
      const of = async () => (await store.dated.ofThread(ana.thread)).map((r) => [r.state, r.deferredUntil]);
      expect(await of()).toEqual([["open", null]]);
      const later = await store.today.waiting.act({ threadId: ana.thread, since: NOW - DAY, message: ana.message, rev: 0, state: "later", until: NOW + DAY, now: NOW });
      expect(await of()).toEqual([["open", NOW + DAY]]);
      const done = await store.today.waiting.act({ threadId: ana.thread, since: NOW - DAY, message: ana.message, rev: 1, state: "done", until: null, now: NOW });
      expect(await of()).toEqual([]);
      await store.today.waiting.restore(done!);
      expect(await of()).toEqual([["open", NOW + DAY]]);
      await store.today.waiting.restore(later!);
      expect(await of()).toEqual([["open", null]]);
      await store.today.waiting.act({ threadId: ana.thread, since: NOW - DAY, message: ana.message, rev: 0, state: "done", until: null, now: NOW });
      expect(await of()).toEqual([]);
    });

    it("Codex code review 2: Undo puts back only what the act changed, each item's revision moving with it", async () => {
      const { store, talk } = await setup();
      const ana = await talk("Ana", NOW - DAY);
      const ask = (item: number) => ({ kind: "ask" as const, item, text: `Ask ${item}`, quote: "q", dueDay: "2026-11-18", dueAt: NOW + DAY, timed: false, dated: false, actAt: NOW });
      await store.dated.marks.queueScan([ana.message], NOW);
      await store.dated.finish({ messageId: ana.message, threadId: ana.thread, fromScan: true, rows: [ask(0), ask(1)], settled: [], now: NOW, model: "m", provider: "p", promptVersion: 1, clearGeneration: store.dated.clearGeneration() });
      const [mine, other] = (await store.dated.ofThread(ana.thread)).sort((a, b) => a.item - b.item);
      // the first put off to Friday by the user's own Later; the conversation's Later to that very Friday leaves it as it is
      const friday = NOW + 3 * DAY;
      await store.dated.update(mine!.id, mine!.revision, { deferredUntil: friday });
      const own = (await store.dated.get(mine!.id))!;
      const later = await store.today.waiting.act({ threadId: ana.thread, since: NOW - DAY, message: ana.message, rev: 0, state: "later", until: friday, now: NOW });
      expect(later!.items.map((i) => i.id)).toEqual([other!.id]);
      // the one it put off moved its revision: an act on it as it was seen before is refused
      expect(await store.dated.update(other!.id, other!.revision, { state: "done" })).toBeNull();
      await store.today.waiting.restore(later!);
      expect((await store.dated.get(mine!.id))!.deferredUntil).toBe(friday);
      expect((await store.dated.get(mine!.id))!.revision).toBe(own.revision);
      expect((await store.dated.get(other!.id))!.deferredUntil).toBeNull();
    });

    it("Codex code review 2: a failed send of yours at the same moment is never the row's message", async () => {
      const { store, accountId, talk, rows } = await setup();
      const ana = await talk("Ana", NOW - DAY);
      const { opId } = await store.compose.queueSend({ accountId, to: [ana.them], cc: [], bcc: [], subject: "Re: x", bodyText: "Sí", inReplyToMessageId: ana.message, recordReply: false, now: NOW - DAY });
      await store.ops.claimReady(NOW, 10);
      expect(await store.ops.fail(opId, "rejected", false, NOW)).toBe("failed");
      expect((await store.threads.summaries([ana.thread]))[0]!.waitingSince).toBe(NOW - DAY);
      expect((await rows(ana.thread, NOW - DAY))?.message).toBe(ana.message);
      expect(await store.today.waiting.act({ threadId: ana.thread, since: NOW - DAY, message: ana.message, rev: 0, state: "done", until: null, now: NOW })).toMatchObject({ messageId: ana.message });
    });

    it("Reply ready stops: a reply written for a conversation marked Done meanwhile isn't kept, whatever its sources say", async () => {
      const { store, talk } = await setup();
      const ana = await talk("Ana", NOW - DAY);
      const stamp = (await store.aiSummaries.sources(ana.thread))!.stamp;
      const write = { rowId: "row-1", expect: null, threadId: ana.thread, sourceStamp: stamp, generationKey: "k", answeringMessageId: ana.message, state: "ready" as const, body: "Hello", used: null, checks: null, to: [ana.them], cc: [], model: "m", provider: "p", promptVersion: 1, generatedAt: NOW, clearGeneration: store.replies.clearGeneration() };
      const done = await store.today.waiting.act({ threadId: ana.thread, since: NOW - DAY, message: ana.message, rev: 0, state: "done", until: null, now: NOW });
      expect((await store.aiSummaries.sources(ana.thread))!.stamp).toBe(stamp);
      expect(await store.replies.finish(write)).toBe("moved");
      expect(await store.replies.get(ana.thread)).toBeNull();
      await store.today.waiting.restore(done!);
      expect(await store.replies.finish(write)).toBe("written");
      // and one written before isn't made ready again once it's Done (in the transition itself)
      const row = (await store.replies.get(ana.thread))!;
      const dismissed = (await store.replies.transition(ana.thread, { rowId: row.rowId, state: "ready", revision: row.revision }, "dismissed"))!;
      const again = await store.today.waiting.act({ threadId: ana.thread, since: NOW - DAY, message: ana.message, rev: 0, state: "done", until: null, now: NOW });
      expect(await store.replies.transition(ana.thread, { rowId: row.rowId, state: "dismissed", revision: dismissed.revision }, "ready")).toBeNull();
      await store.today.waiting.restore(again!);
      expect(await store.replies.transition(ana.thread, { rowId: row.rowId, state: "dismissed", revision: dismissed.revision }, "ready")).toMatchObject({ state: "ready" });
    });

    it("plan 216: Remove takes the row off What matters only: the fact, the Inbox and search as they were, no Earlier line or moment; Undo exact", async () => {
      const { store, talk, again, since, waitingIds, page, rows } = await setup();
      const ana = await talk("Ana", NOW - DAY);
      const bea = await talk("Bea", NOW - 2 * DAY);
      const removed = await store.today.waiting.act({ threadId: ana.thread, since: NOW - DAY, message: ana.message, rev: 0, state: "removed", until: null, now: NOW });
      expect(removed).toEqual({ messageId: ana.message, threadId: ana.thread, rev: 1, before: null, items: [] });
      expect(await since(ana.thread)).toBe(NOW - DAY);
      expect(await waitingIds()).toEqual([ana.thread, bea.thread]);
      expect((await store.threads.counts(NOW)).inboxWaiting).toBe(2);
      expect((await store.threads.searchText({ query: "About", threadFilter: "waiting", limit: 10, now: NOW })).items.map((t) => t.id).sort()).toEqual([ana.thread, bea.thread].sort());
      // Needs you's walk still has it; its row (the list's and the count's) says it's removed, the other's nothing
      expect(await page()).toEqual([ana.thread, bea.thread]);
      expect(await rows(ana.thread, NOW - DAY)).toEqual({ message: ana.message, rev: 1, until: null, removed: true });
      expect(await rows(ana.thread, NOW - DAY, false)).toEqual({ message: null, rev: 1, until: null, removed: true });
      expect(await rows(bea.thread, NOW - 2 * DAY, false)).toBeUndefined();
      expect(await store.today.waiting.donePage({ since: 0, after: null, limit: 10 })).toEqual([]);
      expect(await store.today.waiting.moments(NOW, 10)).toEqual([]);
      // another window's Done or Later on the row as it saw it: stale
      expect(await store.today.waiting.act({ threadId: ana.thread, since: NOW - DAY, message: ana.message, rev: 0, state: "done", until: null, now: NOW })).toBeNull();
      expect(await store.today.waiting.act({ threadId: ana.thread, since: NOW - DAY, message: ana.message, rev: 0, state: "later", until: NOW + DAY, now: NOW })).toBeNull();
      expect(await store.today.waiting.restore(removed!)).toBe(ana.thread);
      expect(await rows(ana.thread, NOW - DAY)).toEqual({ message: ana.message, rev: 0, until: null });
      expect(await rows(ana.thread, NOW - DAY, false)).toBeUndefined();
      // removed again, then a newer message from them: the row is the new message's, never removed
      await store.today.waiting.act({ threadId: ana.thread, since: NOW - DAY, message: ana.message, rev: 0, state: "removed", until: null, now: NOW });
      const newer = await again(ana, NOW - 500);
      expect(await rows(ana.thread, NOW - 500)).toEqual({ message: newer, rev: 0, until: null });
      expect(await rows(ana.thread, NOW - 500, false)).toBeUndefined();
    });

    it("plan 216: Remove after Later and Done after Remove at their revisions; an old Undo never erases a newer choice; Done can't be removed", async () => {
      const { store, talk, since, rows } = await setup();
      const ana = await talk("Ana", NOW - DAY);
      const later = await store.today.waiting.act({ threadId: ana.thread, since: NOW - DAY, message: ana.message, rev: 0, state: "later", until: NOW + DAY, now: NOW });
      const removed = await store.today.waiting.act({ threadId: ana.thread, since: NOW - DAY, message: ana.message, rev: 1, state: "removed", until: null, now: NOW });
      expect(removed?.before).toMatchObject({ state: "later", until: NOW + DAY });
      expect(await rows(ana.thread, NOW - DAY)).toEqual({ message: ana.message, rev: 2, until: null, removed: true });
      expect(await store.today.waiting.moments(NOW, 10)).toEqual([]);
      // the Later's Undo is older than the Remove: refused
      expect(await store.today.waiting.restore(later!)).toBeNull();
      expect(await store.today.waiting.restore(removed!)).toBe(ana.thread);
      expect(await rows(ana.thread, NOW - DAY)).toEqual({ message: ana.message, rev: 1, until: NOW + DAY });
      const again = await store.today.waiting.act({ threadId: ana.thread, since: NOW - DAY, message: ana.message, rev: 1, state: "removed", until: null, now: NOW });
      const done = await store.today.waiting.act({ threadId: ana.thread, since: NOW - DAY, message: ana.message, rev: 2, state: "done", until: null, now: NOW });
      expect(done?.before?.state).toBe("removed");
      expect(await since(ana.thread)).toBeNull();
      expect(await store.today.waiting.restore(again!)).toBeNull();
      // Done is no reply needed: no Remove (nor Later) acts on it; only its Undo reopens it
      expect(await store.today.waiting.act({ threadId: ana.thread, since: NOW - DAY, message: ana.message, rev: 3, state: "removed", until: null, now: NOW })).toBeNull();
      expect(await store.today.waiting.restore(done!)).toBe(ana.thread);
      expect(await rows(ana.thread, NOW - DAY)).toEqual({ message: ana.message, rev: 2, until: null, removed: true });
    });

    it("plan 216: Remove leaves the reader's requests as they are; one read while removed is stored as any; Undo restores a Later's on those", async () => {
      const { store, talk } = await setup();
      const ana = await talk("Ana", NOW - DAY);
      const bea = await talk("Bea", NOW - 2 * DAY);
      const ask = { kind: "ask" as const, item: 0, text: "Send the deck", quote: "q", dueDay: "2026-11-18", dueAt: NOW + DAY, timed: false, dated: false, actAt: NOW };
      const finish = async (c: typeof ana) => {
        await store.dated.marks.queueScan([c.message], NOW);
        expect(await store.dated.finish({ messageId: c.message, threadId: c.thread, fromScan: true, rows: [ask], settled: [], now: NOW, model: "m", provider: "p", promptVersion: 1, clearGeneration: store.dated.clearGeneration() })).toBe("written");
      };
      const of = async (c: typeof ana) => (await store.dated.ofThread(c.thread)).map((r) => [r.state, r.deferredUntil, r.revision]);
      // Bea's request read before: put off with the Later, then left as it is by the Remove and by its Undo
      await finish(bea);
      await store.today.waiting.act({ threadId: bea.thread, since: NOW - 2 * DAY, message: bea.message, rev: 0, state: "later", until: NOW + DAY, now: NOW });
      expect(await of(bea)).toEqual([["open", NOW + DAY, 1]]);
      const gone = await store.today.waiting.act({ threadId: bea.thread, since: NOW - 2 * DAY, message: bea.message, rev: 1, state: "removed", until: null, now: NOW });
      expect(gone?.items).toEqual([]);
      expect(await of(bea)).toEqual([["open", NOW + DAY, 1]]);
      await store.today.waiting.restore(gone!);
      expect(await of(bea)).toEqual([["open", NOW + DAY, 1]]);
      // Ana's read while removed (after a Later): stored open, not put off; Undo brings the Later back and puts it off with it
      const later = await store.today.waiting.act({ threadId: ana.thread, since: NOW - DAY, message: ana.message, rev: 0, state: "later", until: NOW + DAY, now: NOW });
      const removed = await store.today.waiting.act({ threadId: ana.thread, since: NOW - DAY, message: ana.message, rev: 1, state: "removed", until: null, now: NOW });
      await finish(ana);
      expect(await of(ana)).toEqual([["open", null, 0]]);
      await store.today.waiting.restore(removed!);
      expect(await of(ana)).toEqual([["open", NOW + DAY, 1]]);
      expect(await store.today.waiting.restore(later!)).toBe(ana.thread);
      // a Remove with no Later before it: its Undo touches no request
      const plain = await store.today.waiting.act({ threadId: ana.thread, since: NOW - DAY, message: ana.message, rev: 0, state: "removed", until: null, now: NOW });
      const before = await of(ana);
      await store.today.waiting.restore(plain!);
      expect(await of(ana)).toEqual(before);
    });

    it("plan 216: a Remove follows its message into the conversation it's merged into, and so does its Undo", async () => {
      const { store, accountId, talk, rows } = await setup();
      const ana = await talk("Ana", NOW - DAY);
      const removed = await store.today.waiting.act({ threadId: ana.thread, since: NOW - DAY, message: ana.message, rev: 0, state: "removed", until: null, now: NOW });
      // an older conversation of yours with Ana, joined to hers by a message that names both
      await store.sync.ingest([msg({ accountId, date: NOW - 3 * DAY, providerMsgId: "old-out", rfcMessageId: "old-out@t", from: me, to: [ana.them], isSent: true, isRead: true, subject: "Earlier" })], { applyFilters: false, now: NOW, classifier: null });
      await store.sync.ingest([msg({ accountId, date: NOW - 2 * DAY, providerMsgId: "bridge", rfcMessageId: "bridge@t", from: me, to: [ana.them], isSent: true, isRead: true, subject: "Re: About Ana", references: ["old-out@t", `${ana.key}-out@t`], inReplyTo: `${ana.key}-out@t` })], { applyFilters: false, now: NOW, classifier: null });
      const merged = await threadOf(store, `${ana.key}-in`);
      expect(merged).toBe(await threadOf(store, "old-out"));
      expect(await rows(merged, NOW - DAY)).toEqual({ message: ana.message, rev: 1, until: null, removed: true });
      expect(await store.today.waiting.restore(removed!)).toBe(merged);
      expect(await rows(merged, NOW - DAY)).toEqual({ message: ana.message, rev: 0, until: null });
    });

    it("plan 216: the count reads a removed record only at its own message, and stays exact past the page's size", async () => {
      const { store, talk, again, rows } = await setup();
      const convs: Awaited<ReturnType<typeof talk>>[] = [];
      for (const [i, name] of ["Ana", "Bea", "Cleo"].entries()) convs.push(await talk(name, NOW - (i + 1) * DAY));
      const [ana, bea, cleo] = convs as [typeof convs[0], typeof convs[0], typeof convs[0]];
      // Ana's removal goes stale (she wrote again); Bea's holds; Cleo's twin at the same moment isn't the removed one
      await store.today.waiting.act({ threadId: ana.thread, since: NOW - DAY, message: ana.message, rev: 0, state: "removed", until: null, now: NOW });
      const newer = await again(ana, NOW - 500);
      await store.today.waiting.act({ threadId: bea.thread, since: NOW - 2 * DAY, message: bea.message, rev: 0, state: "removed", until: null, now: NOW });
      await store.today.waiting.act({ threadId: cleo.thread, since: NOW - 3 * DAY, message: cleo.message, rev: 0, state: "removed", until: null, now: NOW });
      const twin = await again(cleo, NOW - 3 * DAY);
      const asked = [{ threadId: ana.thread, since: NOW - 500 }, { threadId: bea.thread, since: NOW - 2 * DAY }, { threadId: cleo.thread, since: NOW - 3 * DAY }];
      const count = async (of: typeof asked) => [...(await store.today.waiting.rows(of, NOW, { messages: false }))];
      expect(await count(asked)).toEqual([[bea.thread, { message: null, rev: 1, until: null, removed: true }]]);
      // three removed records, a page of one: the page itself is resolved, the same answer
      expect(await count([asked[1]!])).toEqual([[bea.thread, { message: null, rev: 1, until: null, removed: true }]]);
      expect(await count([asked[0]!])).toEqual([]);
      expect(await rows(cleo.thread, NOW - 3 * DAY)).toEqual({ message: twin, rev: 0, until: null });
      expect((await rows(ana.thread, NOW - 500))?.message).toBe(newer);
    });

    it("a long conversation: the act walks its newest messages only, and judges the same message", async () => {
      const { store, accountId, talk, since } = await setup();
      const ana = await talk("Ana", NOW - 3 * DAY);
      const many = Array.from({ length: FACTS_WINDOW + 50 }, (_, i) => msg({ accountId, date: NOW - 2 * DAY + i, providerMsgId: `${ana.key}-mine-${i}`, providerThreadId: ana.key, from: me, to: [ana.them], isSent: true, isRead: true, subject: "Re: About Ana" }));
      await store.sync.ingest(many, { applyFilters: false, now: NOW, classifier: null });
      const r = await store.sync.ingest([msg({ accountId, date: NOW - DAY, providerMsgId: `${ana.key}-last`, providerThreadId: ana.key, from: ana.them, to: [me], subject: "Re: About Ana" })], { applyFilters: false, now: NOW, classifier: null });
      expect(await since(ana.thread)).toBe(NOW - DAY);
      expect(await store.today.waiting.act({ threadId: ana.thread, since: NOW - DAY, message: ana.message, rev: 0, state: "done", until: null, now: NOW })).toBeNull();
      const done = await store.today.waiting.act({ threadId: ana.thread, since: NOW - DAY, message: r.inserted[0]!, rev: 0, state: "done", until: null, now: NOW });
      expect(done?.messageId).toBe(r.inserted[0]);
      expect(await since(ana.thread)).toBeNull();
      await store.today.waiting.restore(done!);
      expect(await since(ana.thread)).toBe(NOW - DAY);
    });
  });
}
