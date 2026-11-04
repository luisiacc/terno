import { describe, expect, it } from "vitest";
import { NEW_MAIL_MS, type SummaryWrite } from "../ai-summaries";
import type { MailStore } from "../mail-store";
import type { IncomingMessage } from "../types";
import { msg, threadOf, withAccounts } from "./fixtures";

const NOW = Date.UTC(2026, 10, 4, 12);

/**
 * Plans 131 (revision 5) and 132: new mail is marked only by a live ingest, in its commit, whether or not its text is
 * here; a thread's pending summary is queued with it; the result is written only while nothing it read has changed
 * and the thread isn't in spam or trash; a merge invalidates.
 */
export function defineAiSummariesConformance(fresh: () => Promise<MailStore>, reopen: (store: MailStore) => Promise<MailStore>): void {
  describe("AI on new mail (plans 131, 132)", () => {
    async function setup() {
      const store = await fresh();
      const [accountId] = await withAccounts(store, 1);
      /** a message arriving at `at`, as live mail unless said otherwise */
      const arrive = async (over: Partial<IncomingMessage> = {}, o: { at?: number; wants?: { summary?: boolean; category?: boolean } | null } = {}) => {
        const at = o.at ?? NOW;
        const m = msg({ accountId: accountId!, date: at - 60_000, ...over });
        const newMail = o.wants === null ? undefined : (o.wants ?? { summary: true });
        const r = await store.sync.ingest([m], { applyFilters: true, now: at, classifier: null, ...(newMail ? { newMail } : {}) });
        return { id: r.inserted[0]!, thread: await threadOf(store, m.providerMsgId!) };
      };
      /** what a request would read now, to write as `finish` does */
      const write = async (threadId: number, over: Partial<SummaryWrite> = {}, at = NOW): Promise<SummaryWrite> => ({
        threadId,
        stamp: (await store.aiSummaries.sources(threadId))!.stamp,
        expectThrough: (await store.aiSummaries.get(threadId))?.throughMessageId ?? null,
        now: at,
        clearGeneration: store.aiSummaries.clearGeneration(),
        contentHash: "hash",
        promptVersion: 1,
        language: "en",
        model: "gpt-6-luna",
        provider: "openai",
        endpoint: null,
        bodyJson: JSON.stringify({ summary: "S", items: [] }),
        ...over,
      } as SummaryWrite);
      return { store, accountId: accountId!, arrive, write };
    }

    describe("marking", () => {
      it("marks live mail with what the features want; a page is oldest first and a feature only sees its own", async () => {
        const { store, arrive } = await setup();
        const a = await arrive({}, { at: NOW, wants: { summary: true } });
        const b = await arrive({}, { at: NOW + 1, wants: { category: true } });
        const c = await arrive({}, { at: NOW + 2, wants: { summary: true, category: true } });
        expect((await store.newMail.page("summary", null, 10)).map((m) => m.messageId)).toEqual([a.id, c.id]);
        expect((await store.newMail.page("category", null, 10)).map((m) => m.messageId)).toEqual([b.id, c.id]);
        expect(await store.newMail.page("summary", { arrivedAt: NOW, messageId: a.id }, 10)).toMatchObject([{ messageId: c.id, threadId: c.thread, arrivedAt: NOW + 2, wantsSummary: true, wantsCategory: true }]);
      });

      it("a mark goes when nothing wants it; clearing a feature leaves the other's", async () => {
        const { store, arrive } = await setup();
        const a = await arrive({}, { wants: { summary: true, category: true } });
        await store.newMail.consume("summary", [a.id]);
        expect(await store.newMail.page("summary", null, 10)).toEqual([]);
        expect(await store.newMail.page("category", null, 10)).toMatchObject([{ messageId: a.id, wantsSummary: false, wantsCategory: true }]);
        await store.newMail.consume("category", [a.id]);
        expect(await store.newMail.page("category", null, 10)).toEqual([]);

        const b = await arrive({}, { wants: { summary: true, category: true } });
        await store.newMail.clear("category");
        expect((await store.newMail.page("summary", null, 10)).map((m) => m.messageId)).toEqual([b.id]);
        expect(await store.newMail.page("category", null, 10)).toEqual([]);
      });

      it("never marks mail that isn't new: not live, too old, mine, a draft, spam or trash; a late body doesn't change that", async () => {
        const { store, arrive } = await setup();
        await arrive({}, { wants: null });
        await arrive({ date: NOW - NEW_MAIL_MS - 1 });
        await arrive({ from: { name: "Me", email: "ME0@example.com" } });
        await arrive({ isSent: true });
        await arrive({ isDraft: true });
        await arrive({ isSpam: true });
        await arrive({ isTrash: true });
        expect(await store.newMail.page("summary", null, 10)).toEqual([]);
        expect(await store.aiSummaries.pendingCount()).toBe(0);

        // first sync or backfill: no mark when its body arrives later either
        const late = await arrive({ bodyText: null, bodyState: "none" }, { wants: null });
        await store.sync.setBody(late.id, "the whole text of a message that came later", null, { now: NOW, classifier: null });
        expect(await store.newMail.page("summary", null, 10)).toEqual([]);
      });

      it("marks a message whose text isn't here yet, and its text says so", async () => {
        const { store, arrive } = await setup();
        const m = await arrive({ bodyText: null, bodyState: "none" });
        expect((await store.newMail.page("summary", null, 10)).map((r) => r.messageId)).toEqual([m.id]);
        expect((await store.aiSummaries.sources(m.thread))!.messages[0]).toMatchObject({ id: m.id, bodyState: "none", markedAt: NOW });
        expect((await store.aiSummaries.text([{ messageId: m.id, limit: 100 }])).get(m.id)).toBeNull();
        await store.sync.setBody(m.id, "Now it has words", null, { now: NOW, classifier: null });
        expect((await store.aiSummaries.sources(m.thread))!.messages[0]).toMatchObject({ bodyState: "full", markedAt: NOW });
        expect((await store.aiSummaries.text([{ messageId: m.id, limit: 7 }])).get(m.id)).toBe("Now it ");
      });

      it("a message survives a reopen with its mark and its queue; prune drops what's past its moment", async () => {
        const { store, arrive } = await setup();
        const m = await arrive();
        const again = await reopen(store);
        expect((await again.newMail.page("summary", null, 10)).map((r) => r.messageId)).toEqual([m.id]);
        expect((await again.aiSummaries.get(m.thread))?.state).toBe("pending");
        expect(await again.newMail.prune(NOW + NEW_MAIL_MS)).toBe(0);
        expect(await again.newMail.prune(NOW + NEW_MAIL_MS + 1)).toBe(1);
        expect(await again.newMail.page("summary", null, 10)).toEqual([]);
        expect(await again.aiSummaries.prune(NOW + NEW_MAIL_MS, 100)).toBe(0);
        expect(await again.aiSummaries.prune(NOW + NEW_MAIL_MS + 1, 100)).toBe(1);
        expect(await again.aiSummaries.get(m.thread)).toBeNull();
      });

      it("removing a message removes its mark", async () => {
        const { store, arrive } = await setup();
        const a = await arrive({ providerThreadId: "t" });
        await arrive({ providerThreadId: "t" }, { wants: null });
        await store.sync.remove([a.id]);
        expect(await store.newMail.page("summary", null, 10)).toEqual([]);
      });
    });

    describe("the queue", () => {
      it("queues one row a thread; a newer message moves it forward, oldest first", async () => {
        const { store, arrive } = await setup();
        const a = await arrive({ providerThreadId: "a" }, { at: NOW });
        const b = await arrive({ providerThreadId: "b" }, { at: NOW + 1 });
        const a2 = await arrive({ providerThreadId: "a" }, { at: NOW + 2 });
        expect(a2.thread).toBe(a.thread);
        expect(await store.aiSummaries.pendingCount()).toBe(2);
        const page = await store.aiSummaries.pending(null, 10);
        expect(page.map((r) => [r.threadId, r.throughMessageId, r.state])).toEqual([[a.thread, a2.id, "pending"], [b.thread, b.id, "pending"]]);
        expect((await store.aiSummaries.pending({ createdAt: NOW, threadId: a.thread }, 10)).map((r) => r.threadId)).toEqual([b.thread]);
      });

      it("attempts spend up to the limit, then it fails with the last error; the newest failure is findable", async () => {
        const { store, arrive } = await setup();
        const { thread } = await arrive();
        expect(await store.aiSummaries.attempt(thread, "timeout", 3, NOW)).toBe("pending");
        expect(await store.aiSummaries.attempt(thread, "unavailable", 3, NOW)).toBe("pending");
        expect(await store.aiSummaries.lastFailure()).toBeNull();
        expect(await store.aiSummaries.attempt(thread, "rate_limited", 3, NOW + 5)).toBe("failed");
        expect(await store.aiSummaries.get(thread)).toMatchObject({ state: "failed", attempts: 3, errorKind: "rate_limited" });
        expect(await store.aiSummaries.lastFailure()).toEqual({ kind: "rate_limited", at: NOW + 5 });
        expect(await store.aiSummaries.pendingCount()).toBe(0);
        const other = await arrive();
        await store.aiSummaries.fail(other.thread, "refused", NOW + 9);
        expect(await store.aiSummaries.lastFailure()).toEqual({ kind: "refused", at: NOW + 9 });
      });

      it("drop takes it out of the queue with its marks, unless a newer message moved it", async () => {
        const { store, arrive } = await setup();
        const a = await arrive({ providerThreadId: "a" });
        await store.aiSummaries.drop(a.thread, a.id - 1);
        expect((await store.aiSummaries.get(a.thread))?.state).toBe("pending");
        await store.aiSummaries.drop(a.thread, a.id);
        expect(await store.aiSummaries.get(a.thread)).toBeNull();
        expect(await store.newMail.page("summary", null, 10)).toEqual([]);
      });

      it("deleting a thread or its account cascades", async () => {
        const { store, accountId, arrive } = await setup();
        const a = await arrive();
        await store.sync.remove([a.id]);
        expect(await store.aiSummaries.get(a.thread)).toBeNull();
        const b = await arrive();
        await store.accounts.remove(accountId);
        expect(await store.aiSummaries.get(b.thread)).toBeNull();
        expect(await store.newMail.page("summary", null, 10)).toEqual([]);
      });

      it("turned off: nothing stays queued, and a result it held stays where it was", async () => {
        const { store, arrive, write } = await setup();
        const done = await arrive({ providerThreadId: "done" });
        expect(await store.aiSummaries.finish(await write(done.thread))).toBe("written");
        const stale = await arrive({ providerThreadId: "done" });
        const waiting = await arrive({ providerThreadId: "waiting" });
        await store.aiSummaries.dropPending();
        expect(await store.aiSummaries.pendingCount()).toBe(0);
        expect(await store.newMail.page("summary", null, 10)).toEqual([]);
        expect(await store.aiSummaries.get(waiting.thread)).toBeNull();
        expect(await store.aiSummaries.get(stale.thread)).toMatchObject({ state: "ready", bodyJson: expect.any(String) });
      });

      it("prunes the oldest results over the bound, never what's queued", async () => {
        const { store, arrive, write } = await setup();
        const threads: number[] = [];
        for (let i = 0; i < 4; i++) {
          const { thread } = await arrive({ providerThreadId: `t${i}` });
          expect(await store.aiSummaries.finish(await write(thread, {}, NOW + i))).toBe("written");
          threads.push(thread);
        }
        const queued = await arrive({ providerThreadId: "queued" });
        expect(await store.aiSummaries.prune(NOW, 3)).toBe(2);
        expect(await store.aiSummaries.get(threads[0]!)).toBeNull();
        expect(await store.aiSummaries.get(threads[1]!)).toBeNull();
        expect(await store.aiSummaries.get(threads[2]!)).not.toBeNull();
        expect((await store.aiSummaries.get(queued.thread))?.state).toBe("pending");
      });

      it("clearing empties the table and the queue's marks", async () => {
        const { store, arrive, write } = await setup();
        const a = await arrive({ providerThreadId: "a" });
        await store.aiSummaries.finish(await write(a.thread));
        await arrive({ providerThreadId: "b" });
        await store.aiSummaries.clear();
        expect(await store.aiSummaries.get(a.thread)).toBeNull();
        expect(await store.aiSummaries.pendingCount()).toBe(0);
        expect(await store.newMail.page("summary", null, 10)).toEqual([]);
      });

      it("a write that started before a clear brings nothing back; one that started after writes", async () => {
        const { store, arrive, write } = await setup();
        const a = await arrive({ providerThreadId: "a" });
        const before = await write(a.thread);
        await store.aiSummaries.clear();
        expect(await store.aiSummaries.finish(before)).toBe("gone");
        expect(await store.aiSummaries.get(a.thread)).toBeNull();
        expect(await store.aiSummaries.finish(await write(a.thread))).toBe("written");
      });

      it("a write and a clear asked for at once leave nothing, whichever runs first", async () => {
        const { store, arrive, write } = await setup();
        const a = await arrive({ providerThreadId: "a" });
        const before = await write(a.thread);
        await Promise.all([store.aiSummaries.finish(before), store.aiSummaries.clear()]);
        expect(await store.aiSummaries.get(a.thread)).toBeNull();
      });
    });

    describe("writing a result", () => {
      it("writes it, consumes the thread's marks and survives a reopen", async () => {
        const { store, arrive, write } = await setup();
        const { thread, id } = await arrive({}, { wants: { summary: true, category: true } });
        expect(await store.aiSummaries.finish(await write(thread))).toBe("written");
        expect(await store.newMail.page("summary", null, 10)).toEqual([]);
        expect(await store.newMail.page("category", null, 10)).toMatchObject([{ messageId: id }]);
        const again = await reopen(store);
        const sources = await again.aiSummaries.sources(thread);
        expect(await again.aiSummaries.get(thread)).toMatchObject({ state: "ready", throughMessageId: id, sourceStamp: sources!.stamp, contentHash: "hash", promptVersion: 1, language: "en", model: "gpt-6-luna", provider: "openai", endpoint: null, attempts: 0, generatedAt: NOW });
      });

      it("a newer message mid-request makes it `moved`; so does a replaced body, and a removed source", async () => {
        const { store, arrive, write } = await setup();
        const first = await arrive({ providerThreadId: "t", bodyText: "one", bodyState: "full" });
        const second = await arrive({ providerThreadId: "t" }, { wants: null });
        const read = await write(first.thread);
        await arrive({ providerThreadId: "t" });
        expect(await store.aiSummaries.finish(read)).toBe("moved");

        const before = await write(first.thread);
        await store.sync.setBody(first.id, "one, but replaced by a longer text", null, { now: NOW, classifier: null });
        expect((await store.aiSummaries.sources(first.thread))!.stamp).not.toBe(before.stamp);
        expect(await store.aiSummaries.finish(before)).toBe("moved");

        const beforeRemove = await write(first.thread);
        await store.sync.remove([second.id]);
        expect((await store.aiSummaries.sources(first.thread))!.stamp).not.toBe(beforeRemove.stamp);
        expect(await store.aiSummaries.finish(beforeRemove)).toBe("moved");
        expect(await store.aiSummaries.finish(await write(first.thread))).toBe("written");
      });

      it("a message moved to spam or trash blocks it; a clean root doesn't hide a later spam message (revision 1)", async () => {
        const { store, arrive, write } = await setup();
        const spam = await arrive({ providerThreadId: "spam" });
        const read = await write(spam.thread);
        await store.threads.act({ threadIds: [spam.thread], action: "spam", signal: null, now: NOW });
        expect(await store.aiSummaries.finish(read)).toBe("blocked");
        expect((await store.aiSummaries.get(spam.thread))?.bodyJson ?? null).toBeNull();

        const trash = await arrive({ providerThreadId: "trash" });
        const trashRead = await write(trash.thread);
        await store.threads.act({ threadIds: [trash.thread], action: "trash", signal: null, now: NOW });
        expect(await store.aiSummaries.finish(trashRead)).toBe("blocked");

        const mixed = await arrive({ providerThreadId: "mixed" });
        await store.sync.ingest([msg({ accountId: (await store.accounts.list())[0]!.id, providerThreadId: "mixed", isSpam: true, inInbox: false, date: NOW })], { applyFilters: true, now: NOW, classifier: null });
        const sources = await store.aiSummaries.sources(mixed.thread);
        expect(sources).toMatchObject({ hasSpam: true });
        expect(await store.aiSummaries.finish(await write(mixed.thread))).toBe("blocked");
      });

      it("a result moved to spam after it stays, and is back with Not spam, with no new write", async () => {
        const { store, arrive, write } = await setup();
        const { thread } = await arrive();
        await store.aiSummaries.finish(await write(thread));
        const { stamp } = (await store.aiSummaries.sources(thread))!;
        await store.threads.act({ threadIds: [thread], action: "spam", signal: null, now: NOW });
        expect(await store.aiSummaries.sources(thread)).toMatchObject({ hasSpam: true, inSpam: true });
        expect((await store.aiSummaries.get(thread))?.state).toBe("ready");
        await store.threads.act({ threadIds: [thread], action: "notSpam", signal: null, now: NOW });
        expect(await store.aiSummaries.sources(thread)).toMatchObject({ hasSpam: false, stamp });
        expect((await store.aiSummaries.get(thread))?.sourceStamp).toBe(stamp);
      });

      it("a hand request with no row writes one; a reuse keeps the original provenance", async () => {
        const { store, accountId, write } = await setup();
        const old = msg({ accountId, date: NOW - 90 * 86_400_000 });
        await store.sync.ingest([old], { applyFilters: true, now: NOW, classifier: null });
        const thread = await threadOf(store, old.providerMsgId!);
        expect(await store.aiSummaries.get(thread)).toBeNull();
        expect(await store.aiSummaries.finish(await write(thread))).toBe("written");
        expect(await store.aiSummaries.get(thread)).toMatchObject({ state: "ready", model: "gpt-6-luna", generatedAt: NOW });
        const later = await write(thread, { reuse: true, now: NOW + 1000 } as Partial<SummaryWrite>);
        expect(await store.aiSummaries.finish(later)).toBe("written");
        expect(await store.aiSummaries.get(thread)).toMatchObject({ state: "ready", model: "gpt-6-luna", generatedAt: NOW });
      });

      it("a reuse with no stored result isn't one", async () => {
        const { store, arrive, write } = await setup();
        const { thread } = await arrive();
        expect(await store.aiSummaries.finish(await write(thread, { reuse: true } as Partial<SummaryWrite>))).toBe("moved");
      });
    });

    describe("what a request reads", () => {
      it("gives the thread's flags, the messages oldest first without drafts, whose they are, and a stamp that ignores drafts", async () => {
        const { store, accountId, arrive } = await setup();
        const first = await arrive({ providerThreadId: "t", from: { name: "Ana", email: "ana@books.test" }, date: NOW - 2000 });
        const before = (await store.aiSummaries.sources(first.thread))!.stamp;
        await store.sync.ingest([msg({ accountId, providerThreadId: "t", isDraft: true, date: NOW - 1500 })], { applyFilters: false, now: NOW, classifier: null });
        expect((await store.aiSummaries.sources(first.thread))!.stamp).toBe(before);
        await store.sync.ingest([msg({ accountId, providerThreadId: "t", isSent: true, from: { name: "Me", email: "me0@example.com" }, date: NOW - 1000 })], { applyFilters: false, now: NOW, classifier: null });
        const s = (await store.aiSummaries.sources(first.thread))!;
        expect(s).toMatchObject({ threadId: first.thread, accountId, inInbox: true, inSpam: false, inTrash: false, hasSpam: false, tab: 0 });
        expect(s.stamp).not.toBe(before);
        expect(s.messages.map((m) => [m.fromName, m.own, m.markedAt])).toEqual([["Ana", false, NOW], ["Me", true, null]]);
      });

      it("reads the start of a long body, whatever way it's stored, and nothing for a thread that isn't there", async () => {
        const { store, arrive } = await setup();
        const long = "word ".repeat(40_000);
        const { id } = await arrive({ bodyText: long });
        expect((await store.aiSummaries.text([{ messageId: id, limit: 12 }])).get(id)).toBe(long.slice(0, 12));
        expect((await store.aiSummaries.text([{ messageId: id, limit: 1_000_000 }])).get(id)).toBe(long);
        expect(await store.aiSummaries.sources(999_999)).toBeNull();
      });

      it("reports the Gmail tab, so an automatic summary can stay out of Promotions and Social", async () => {
        const { store, arrive } = await setup();
        const promo = await arrive({ gmailLabels: ["INBOX", "CATEGORY_PROMOTIONS"] });
        const social = await arrive({ gmailLabels: ["INBOX", "CATEGORY_SOCIAL"] });
        const primary = await arrive({ gmailLabels: ["INBOX", "CATEGORY_PERSONAL"] });
        expect((await store.aiSummaries.sources(promo.thread))!.tab).toBe(1);
        expect((await store.aiSummaries.sources(social.thread))!.tab).toBe(2);
        expect((await store.aiSummaries.sources(primary.thread))!.tab).toBe(0);
      });
    });

    describe("merges", () => {
      /** two threads an account's provider later says are one */
      async function split(store: MailStore, accountId: number, wants: { first: boolean; second: boolean }) {
        const a = msg({ accountId, providerMsgId: "merge-a", rfcMessageId: "merge-a@t", subject: "One", date: NOW - 5000 });
        const c = msg({ accountId, providerMsgId: "merge-c", rfcMessageId: "merge-c@t", subject: "Other", date: NOW - 4000 });
        const ingestOne = (m: IncomingMessage, marked: boolean) => store.sync.ingest([m], { applyFilters: true, now: NOW, classifier: null, ...(marked ? { newMail: { summary: true } } : {}) });
        const ra = await ingestOne(a, wants.first);
        const rc = await ingestOne(c, wants.second);
        const threadA = await threadOf(store, "merge-a");
        const threadC = await threadOf(store, "merge-c");
        expect(threadA).not.toBe(threadC);
        // a message naming both joins the threads
        const bridge = msg({ accountId, providerMsgId: "merge-b", references: ["merge-a@t", "merge-c@t"], date: NOW - 3000 });
        const join = async () => {
          await store.sync.ingest([bridge], { applyFilters: true, now: NOW, classifier: null });
          const survivor = await threadOf(store, "merge-b");
          expect([await threadOf(store, "merge-a"), await threadOf(store, "merge-c")]).toEqual([survivor, survivor]);
          return survivor;
        };
        return { threadA, threadC, a: ra.inserted[0]!, c: rc.inserted[0]!, join };
      }

      it("the marks follow their messages and the survivor is queued again, its old result gone", async () => {
        const { store, accountId, write } = await setup();
        const { threadA, threadC, c, join } = await split(store, accountId, { first: true, second: true });
        expect(await store.aiSummaries.finish(await write(threadA))).toBe("written");
        const survivor = await join();
        expect(await store.aiSummaries.get(survivor)).toMatchObject({ state: "pending", throughMessageId: c, bodyJson: null });
        const gone = survivor === threadA ? threadC : threadA;
        expect(await store.aiSummaries.get(gone)).toBeNull();
        expect((await store.newMail.page("summary", null, 10)).map((m) => [m.messageId, m.threadId])).toEqual([[c, survivor]]);
      });

      it("with no live mark, the stale result goes and nothing is queued", async () => {
        const { store, accountId, write } = await setup();
        const { threadA, join } = await split(store, accountId, { first: true, second: false });
        expect(await store.aiSummaries.finish(await write(threadA))).toBe("written");
        const survivor = await join();
        expect(await store.aiSummaries.get(survivor)).toBeNull();
        expect(await store.aiSummaries.pendingCount()).toBe(0);
      });
    });
  });
}
