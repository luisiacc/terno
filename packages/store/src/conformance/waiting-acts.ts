import { FACTS_WINDOW } from "@terno/core";
import { describe, expect, it } from "vitest";
import type { MailStore } from "../mail-store";
import type { IncomingMessage } from "../types";
import { WAITING_CLOSED, WAITING_DEFERRED_MAX } from "../waiting-acts";
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
      return { store, accountId: accountId!, talk, again, since, waitingIds, page };
    }

    it("Done clears the fact in the same write: the Inbox's filter and count, search, Needs you agree; Undo puts it back exactly", async () => {
      const { store, talk, since, waitingIds, page } = await setup();
      const ana = await talk("Ana", NOW - DAY);
      const bea = await talk("Bea", NOW - 2 * DAY);
      expect((await store.today.waitingPage({ now: NOW, after: null, limit: 5 })).map((p) => [p.id, p.waitingSince])).toEqual([[ana.thread, NOW - DAY], [bea.thread, NOW - 2 * DAY]]);
      expect((await store.threads.counts(NOW)).inboxWaiting).toBe(2);
      // at a date or a revision that isn't what's there: nothing written
      expect(await store.today.waiting.act({ threadId: ana.thread, since: NOW - 2 * DAY, rev: 0, state: "done", until: null, now: NOW })).toBeNull();
      expect(await store.today.waiting.act({ threadId: ana.thread, since: NOW - DAY, rev: 1, state: "done", until: null, now: NOW })).toBeNull();
      const done = await store.today.waiting.act({ threadId: ana.thread, since: NOW - DAY, rev: 0, state: "done", until: null, now: NOW });
      expect(done).toEqual({ messageId: ana.message, threadId: ana.thread, rev: 1, before: null });
      expect(await since(ana.thread)).toBeNull();
      expect(await waitingIds()).toEqual([bea.thread]);
      expect((await store.threads.counts(NOW)).inboxWaiting).toBe(1);
      expect(await page()).toEqual([bea.thread]);
      expect((await store.threads.searchText({ query: "About", threadFilter: "waiting", limit: 10, now: NOW })).items.map((t) => t.id)).toEqual([bea.thread]);
      const docs = new Map((await store.debug.snapshot()).search.threads.map((d) => [d.threadId, d]));
      expect(docs.get(ana.thread)?.waitingSince ?? null).toBeNull();
      // a second act on what it showed is stale (Later on a row done meanwhile too)
      expect(await store.today.waiting.act({ threadId: ana.thread, since: NOW - DAY, rev: 0, state: "later", until: NOW + DAY, now: NOW })).toBeNull();
      expect(await store.today.waiting.restore(done!)).toBe(ana.thread);
      expect(await since(ana.thread)).toBe(NOW - DAY);
      expect(await waitingIds()).toEqual([ana.thread, bea.thread]);
      expect((await store.threads.counts(NOW)).inboxWaiting).toBe(2);
      expect(await store.today.waiting.revs([{ threadId: ana.thread, since: NOW - DAY }])).toEqual(new Map());
      // its Undo once more: the record isn't the act's any more
      expect(await store.today.waiting.restore(done!)).toBeNull();
    });

    it("a newer message from them waits again by itself; the record stays with its message and goes with it", async () => {
      const { store, talk, again, since, page } = await setup();
      const ana = await talk("Ana", NOW - 2 * DAY);
      await store.today.waiting.act({ threadId: ana.thread, since: NOW - 2 * DAY, rev: 0, state: "done", until: null, now: NOW - DAY });
      expect(await since(ana.thread)).toBeNull();
      await again(ana, NOW - 1000);
      expect(await since(ana.thread)).toBe(NOW - 1000);
      expect(await page()).toEqual([ana.thread]);
      // the new message has no record: the row is drawn at revision 0, and its Done is its own
      expect(await store.today.waiting.revs([{ threadId: ana.thread, since: NOW - 1000 }])).toEqual(new Map());
      expect((await store.today.waiting.donePage({ since: 0, after: null, limit: 10 })).map((d) => d.messageId)).toEqual([ana.message]);
      await store.sync.remove([ana.message]);
      expect(await store.today.waiting.donePage({ since: 0, after: null, limit: 10 })).toEqual([]);
    });

    it("Later leaves the fact as it is (the Inbox keeps it), reads by its own moment, moves, gives way to Done, and is pruned when over", async () => {
      const { store, talk, again, since, waitingIds, page } = await setup();
      const ana = await talk("Ana", NOW - DAY);
      const later = await store.today.waiting.act({ threadId: ana.thread, since: NOW - DAY, rev: 0, state: "later", until: NOW + DAY, now: NOW });
      expect(later).toEqual({ messageId: ana.message, threadId: ana.thread, rev: 1, before: null });
      expect(await since(ana.thread)).toBe(NOW - DAY);
      expect(await waitingIds()).toEqual([ana.thread]);
      // Needs you's walk still has it: What matters places it by the deferral (the projection)
      expect(await page()).toEqual([ana.thread]);
      const deferred = { threadId: ana.thread, until: NOW + DAY, rev: 1, lastDate: NOW - DAY, hasSent: true, waitingSince: NOW - DAY };
      expect(await store.today.waiting.deferred(NOW, WAITING_DEFERRED_MAX)).toEqual([deferred]);
      expect(await store.today.waiting.deferred(NOW + DAY, WAITING_DEFERRED_MAX)).toEqual([]);
      expect(await store.today.waiting.revs([{ threadId: ana.thread, since: NOW - DAY }])).toEqual(new Map([[ana.thread, 1]]));
      // moved: at its revision; its Undo puts the first Later back, whole
      const moved = await store.today.waiting.act({ threadId: ana.thread, since: NOW - DAY, rev: 1, state: "later", until: NOW + 2 * DAY, now: NOW + 1 });
      expect(moved?.before).toMatchObject({ state: "later", until: NOW + DAY, rev: 1, who: "Ana" });
      expect((await store.today.waiting.deferred(NOW, 10)).map((d) => [d.until, d.rev])).toEqual([[NOW + 2 * DAY, 2]]);
      expect(await store.today.waiting.restore(moved!)).toBe(ana.thread);
      expect(await store.today.waiting.deferred(NOW, 10)).toEqual([deferred]);
      // Done on the deferred row replaces it (one record a message)
      const done = await store.today.waiting.act({ threadId: ana.thread, since: NOW - DAY, rev: 1, state: "done", until: null, now: NOW + 2 });
      expect(done?.before?.state).toBe("later");
      expect(await store.today.waiting.deferred(NOW, 10)).toEqual([]);
      expect(await since(ana.thread)).toBeNull();
      await store.today.waiting.restore(done!);
      // a newer message from them isn't put off: the deferral no longer holds
      await again(ana, NOW - 500);
      expect(await store.today.waiting.deferred(NOW, 10)).toEqual([]);
      // over, it goes
      expect(await store.today.waiting.prune(NOW + DAY)).toBe(1);
      expect(await store.today.waiting.prune(NOW + DAY)).toBe(0);
    });

    it("a deferral of a conversation in the Trash, or past the waiting window, doesn't hold", async () => {
      const { store, talk } = await setup();
      const ana = await talk("Ana", NOW - DAY);
      const bea = await talk("Bea", NOW - 2 * DAY);
      await store.today.waiting.act({ threadId: ana.thread, since: NOW - DAY, rev: 0, state: "later", until: NOW + 40 * DAY, now: NOW });
      await store.today.waiting.act({ threadId: bea.thread, since: NOW - 2 * DAY, rev: 0, state: "later", until: NOW + DAY, now: NOW });
      expect((await store.today.waiting.deferred(NOW, 10)).map((d) => d.threadId)).toEqual([bea.thread, ana.thread]);
      expect((await store.today.waiting.deferred(NOW, 1)).map((d) => d.threadId)).toEqual([bea.thread]);
      await store.threads.act({ threadIds: [bea.thread], action: "trash", signal: null, now: NOW });
      expect((await store.today.waiting.deferred(NOW + 30 * DAY, 10)).map((d) => d.threadId)).toEqual([]);
    });

    it("Earlier's page: Done records by their moment, then the message, newest first, paged strictly after a key", async () => {
      const { store, talk } = await setup();
      const convs: Awaited<ReturnType<typeof talk>>[] = [];
      for (const [i, name] of ["Ana", "Bea", "Cleo", "Dia"].entries()) convs.push(await talk(name, NOW - (i + 1) * DAY));
      const at = [NOW, NOW, NOW - 5, NOW];
      for (const [i, c] of convs.entries()) await store.today.waiting.act({ threadId: c.thread, since: NOW - (i + 1) * DAY, rev: 0, state: "done", until: null, now: at[i]! });
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
      await store.today.waiting.act({ threadId: ana.thread, since: NOW - DAY, rev: 0, state: "done", until: null, now: NOW });
      await store.today.waiting.act({ threadId: bea.thread, since: NOW - 2 * DAY, rev: 0, state: "later", until: NOW + DAY, now: NOW });
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

    it("Reply ready stops: a reply written for a conversation marked Done meanwhile isn't kept, whatever its sources say", async () => {
      const { store, talk } = await setup();
      const ana = await talk("Ana", NOW - DAY);
      const stamp = (await store.aiSummaries.sources(ana.thread))!.stamp;
      const write = { rowId: "row-1", expect: null, threadId: ana.thread, sourceStamp: stamp, generationKey: "k", answeringMessageId: ana.message, state: "ready" as const, body: "Hello", used: null, checks: null, to: [ana.them], cc: [], model: "m", provider: "p", promptVersion: 1, generatedAt: NOW, clearGeneration: store.replies.clearGeneration() };
      const done = await store.today.waiting.act({ threadId: ana.thread, since: NOW - DAY, rev: 0, state: "done", until: null, now: NOW });
      expect((await store.aiSummaries.sources(ana.thread))!.stamp).toBe(stamp);
      expect(await store.replies.finish(write)).toBe("moved");
      expect(await store.replies.get(ana.thread)).toBeNull();
      await store.today.waiting.restore(done!);
      expect(await store.replies.finish(write)).toBe("written");
    });

    it("a long conversation: the act walks its newest messages only, and judges the same message", async () => {
      const { store, accountId, talk, since } = await setup();
      const ana = await talk("Ana", NOW - 3 * DAY);
      const many = Array.from({ length: FACTS_WINDOW + 50 }, (_, i) => msg({ accountId, date: NOW - 2 * DAY + i, providerMsgId: `${ana.key}-mine-${i}`, providerThreadId: ana.key, from: me, to: [ana.them], isSent: true, isRead: true, subject: "Re: About Ana" }));
      await store.sync.ingest(many, { applyFilters: false, now: NOW, classifier: null });
      const r = await store.sync.ingest([msg({ accountId, date: NOW - DAY, providerMsgId: `${ana.key}-last`, providerThreadId: ana.key, from: ana.them, to: [me], subject: "Re: About Ana" })], { applyFilters: false, now: NOW, classifier: null });
      expect(await since(ana.thread)).toBe(NOW - DAY);
      const done = await store.today.waiting.act({ threadId: ana.thread, since: NOW - DAY, rev: 0, state: "done", until: null, now: NOW });
      expect(done?.messageId).toBe(r.inserted[0]);
      expect(await since(ana.thread)).toBeNull();
      await store.today.waiting.restore(done!);
      expect(await since(ana.thread)).toBe(NOW - DAY);
    });
  });
}
