import { describe, expect, it } from "vitest";
import type { MailStore } from "../mail-store";
import type { IncomingMessage } from "../types";
import { msg, threadOf, withAccounts } from "./fixtures";

const NOW = Date.UTC(2026, 10, 5, 12);
const me = { name: "Me", email: "me0@example.com" };

/** Plan 145: the reads Today makes, and the digest's table, the same in both stores. */
export function defineTodayConformance(fresh: () => Promise<MailStore>): void {
  describe("Today (plan 145)", () => {
    let accountId_: () => number = () => 0;
    async function setup() {
      const store = await fresh();
      const [accountId] = await withAccounts(store, 1);
      let seq = 0;
      const put = async (over: Partial<IncomingMessage> = {}) => {
        const id = `t-${seq++}`;
        const m = msg({ date: NOW - 1000 - seq, providerMsgId: id, from: { name: "News", email: "news@letter.test" }, to: [me], isRead: false, listId: "list-1", subject: `Issue ${seq}`, ...over, accountId: accountId! });
        const r = await store.sync.ingest([m], { applyFilters: false, now: NOW, classifier: null });
        return { message: r.inserted[0]!, thread: await threadOf(store, id) };
      };
      accountId_ = () => accountId!;
      return { store, accountId: accountId!, put };
    }

    it("a person's mail, an empty mailbox: nothing qualifies, and the walk knows how far it's read", async () => {
      const { store, put } = await setup();
      expect(await store.today.digestFacts([])).toEqual({ facts: [], oldest: null });
      const person = await put({ listId: null, from: { name: "Ana", email: "ana@x.test" } });
      const { facts, oldest } = await store.today.digestFacts([person.message]);
      expect(facts).toEqual([]);
      expect(oldest).not.toBeNull();
    });

    it("plan 166: a candidate carries its sender's address, and senders reads any stored message's by its id", async () => {
      const { store, put } = await setup();
      const letter = await put({ from: { name: "Stratechery", email: "Email@Stratechery.test" } });
      const { facts } = await store.today.digestFacts([letter.message]);
      expect(facts.map((f) => [f.from, f.fromEmail])).toEqual([["Stratechery", "email@stratechery.test"]]);
      // stored as ingest keeps it (lowercased); any message, a candidate or not (a person's, a read one), and nothing for an id not stored
      const person = await put({ listId: null, isRead: true, from: { name: "Ana", email: "ana@x.test" } });
      const found = await store.today.senders([letter.message, person.message, 987_654]);
      expect(found.get(letter.message)).toBe("email@stratechery.test");
      expect(found.get(person.message)).toBe("ana@x.test");
      expect(found.size).toBe(2);
      expect(await store.today.senders([])).toEqual(new Map());
    });

    it("what's read, starred, in Spam or Trash, or archived isn't a candidate", async () => {
      const { store, put } = await setup();
      const facts = async (id: number) => (await store.today.digestFacts([id])).facts;
      const read = await put({ isRead: true });
      expect(await facts(read.message)).toEqual([]);
      const starred = await put();
      await store.threads.act({ threadIds: [starred.thread], action: "star", signal: null, now: NOW });
      expect(await facts(starred.message)).toEqual([]);
      const spam = await put();
      await store.threads.act({ threadIds: [spam.thread], action: "spam", signal: null, now: NOW });
      expect(await facts(spam.message)).toEqual([]);
      const archived = await put();
      await store.threads.act({ threadIds: [archived.thread], action: "archive", signal: null, now: NOW });
      expect(await facts(archived.message)).toEqual([]);
      const sent = await put({ isSent: true, from: me });
      expect(await facts(sent.message)).toEqual([]);
    });

    it("the waiting walk goes newest first, in pages, and among says which are", async () => {
      const { store, put } = await setup();
      // a conversation they're in: their own message, then the answer
      const talk = async (name: string, date: number, subject = `About ${name}`) => {
        const email = `${name.toLowerCase()}@people.test`;
        const threadKey = `conv-${name}-${subject}`;
        await store.sync.ingest([msg({ date: date - 500, providerMsgId: `${threadKey}-out`, providerThreadId: threadKey, from: me, to: [{ name, email }], isSent: true, subject, accountId: accountId_(), listId: null })], { applyFilters: false, now: NOW, classifier: null });
        return put({ listId: null, from: { name, email }, date, subject, providerThreadId: threadKey, inReplyTo: `${threadKey}-out` });
      };
      const a = await talk("Ana", NOW - 5000);
      const b = await talk("Bea", NOW - 1000);
      // never written back: a service's notice from a plain address
      const notice = await put({ listId: null, from: { name: "Bank", email: "notices@bank.test" }, date: NOW - 900 });
      const calendar = await talk("Cleo", NOW - 800, "Aceptado: Demo");
      const page = await store.today.waitingPage({ now: NOW, after: null, limit: 1 });
      const waiting = (await store.threads.summaries([a.thread, b.thread])).filter((t) => t.waitingSince != null).map((t) => t.id);
      expect(waiting).toHaveLength(2);
      expect(page.map((p) => p.id)).toEqual([b.thread]);
      // plan 161: why it's there, for the row's reason: a conversation they've written in
      expect(page[0]!.hasSent).toBe(true);
      const next = await store.today.waitingPage({ now: NOW, after: page[0]!, limit: 5 });
      expect(next.map((p) => p.id)).toEqual([a.thread]);
      expect(new Set(await store.today.waitingAmong([a.thread, b.thread, notice.thread, calendar.thread, 999_999], NOW))).toEqual(new Set(waiting));
      expect(await store.today.needsCount(NOW)).toBe(2);
      // plan 204: one walk for the sidebar: a waiting thread isn't counted twice, an unknown one not at all, and Spam or Trash hides one
      expect(await store.today.countWith([a.thread, notice.thread, notice.thread, calendar.thread, 999_999], NOW)).toEqual({ needs: 2, extra: 2 });
      await store.threads.act({ threadIds: [calendar.thread], action: "trash", signal: null, now: NOW });
      expect(await store.today.countWith([a.thread, notice.thread, calendar.thread], NOW)).toEqual({ needs: 2, extra: 1 });
      // the third panel round: a waiting thread placed in a group that isn't counted (a Plan) isn't counted as waiting
      expect(await store.today.countWith([notice.thread], NOW, [b.thread, 999_999])).toEqual({ needs: 1, extra: 1 });
      expect(await store.today.countWith([], NOW, [a.thread, b.thread])).toEqual({ needs: 0, extra: 0 });
      // the seventh panel round: a waiting thread placed as a counted row (Soon's bill) counts once, as waiting, beside one
      // placed as an uncounted row (Today's appointment) and a counted one that isn't waiting
      expect(await store.today.countWith([a.thread, notice.thread], NOW, [b.thread])).toEqual({ needs: 1, extra: 1 });
      // plan 210 (iteration 1): a waiting conversation with a bill and a dinner on one day is placed as the bill (counted,
      // once, as waiting), one with only a dinner as the dinner (not counted): the header's, the sidebar's and the
      // notice's numbers are the same rows in both stores
      expect(await store.today.countWith([a.thread, a.thread], NOW, [b.thread])).toEqual({ needs: 1, extra: 0 });
      // someone they've written to, from a tagged address: their one new conversation counts, in both stores
      await store.sync.ingest([msg({ date: NOW - 700, providerMsgId: "to-dia", providerThreadId: "to-dia", from: me, to: [{ name: "Dia", email: "dia@people.test" }], isSent: true, subject: "Hello", accountId: accountId_(), listId: null })], { applyFilters: false, now: NOW, classifier: null });
      const dia = await put({ listId: null, from: { name: "Dia", email: "dia+work@people.test" }, date: NOW - 600, subject: "Something new" });
      if ((await store.threads.summaries([dia.thread]))[0]!.waitingSince != null) {
        expect(await store.today.needsCount(NOW)).toBe(3);
        // plan 161: and the other reason, new from someone they write to
        expect((await store.today.waitingPage({ now: NOW, after: null, limit: 5 })).find((p) => p.id === dia.thread)?.hasSent).toBe(false);
      }
    });

    it("plan 204, the second panel round: a thanks, or a current summary that asks nothing, isn't waiting on you", async () => {
      const { store } = await setup();
      // arrival (created_at) and a summary's writing are compared: mail arrives at NOW, summaries are written at NOW + 1
      const ingest = (m: Partial<IncomingMessage>, summary = false, at = NOW) =>
        store.sync.ingest([msg({ listId: null, isRead: false, to: [me], ...m, accountId: accountId_() })], { applyFilters: false, now: at, classifier: null, ...(summary ? { newMail: { summary: true } } : {}) });
      /** their own message, then the answer: a conversation they're in */
      const talk = async (name: string, date: number, text: string, summary = false) => {
        const email = `${name.toLowerCase()}@people.test`;
        await ingest({ date: date - 500, providerMsgId: `${name}-out`, providerThreadId: name, from: me, to: [{ name, email }], isSent: true, isRead: true, subject: `About ${name}` });
        await ingest({ date, providerMsgId: `${name}-in`, providerThreadId: name, from: { name, email }, subject: `Re: About ${name}`, inReplyTo: `${name}-out`, snippet: text.slice(0, 120), bodyText: text }, summary);
        return threadOf(store, `${name}-in`);
      };
      const summarize = async (thread: number, promptVersion: number, bodyJson: string) => {
        const r = await store.aiSummaries.finish({
          threadId: thread,
          stamp: (await store.aiSummaries.sources(thread))!.stamp,
          expectThrough: (await store.aiSummaries.get(thread))?.throughMessageId ?? null,
          now: NOW + 1,
          clearGeneration: store.aiSummaries.clearGeneration(),
          contentHash: "hash",
          promptVersion,
          language: "en",
          model: "gpt-6-luna",
          provider: "openai",
          endpoint: null,
          bodyJson,
        });
        expect(r).toBe("written");
      };
      const nothing = JSON.stringify({ summary: "Ana sent the contract.", items: [{ kind: "fact", text: "The contract is attached." }] });
      const ack = await talk("Ana", NOW - 9000, "Thanks!\n\nAna\n\nOn Tue, Me wrote:\n> Can you send the deck?");
      const ackAsks = await talk("Bea", NOW - 8000, "Thanks, can you send it Friday?");
      const told = await talk("Cleo", NOW - 7000, "Here's the contract.", true);
      await summarize(told, 7, nothing);
      const asked = await talk("Dia", NOW - 6000, "Here's the contract.", true);
      await summarize(asked, 7, JSON.stringify({ summary: "Dia sent the contract to sign.", items: [{ kind: "action", text: "Sign it" }] }));
      const older = await talk("Eve", NOW - 5000, "Here's the contract.", true);
      await summarize(older, 6, nothing);
      const malformed = await talk("Fay", NOW - 4000, "Here's the contract.", true);
      await summarize(malformed, 7, JSON.stringify({ summary: "No items" }));
      const stale = await talk("Gus", NOW - 3000, "Here's the contract.", true);
      await summarize(stale, 7, nothing);
      // a later message the summary hasn't read: it can't speak for it
      await ingest({ date: NOW - 2000, providerMsgId: "Gus-in-2", providerThreadId: "Gus", from: { name: "Gus", email: "gus@people.test" }, subject: "Re: About Gus", inReplyTo: "Gus-in", bodyText: "One more thing." }, false, NOW + 2);
      // Codex code review: a request queued for a summary, then dropped (too short to read), leaves the old one ready with
      // its watermark moved past the new mail: it still can't speak for it
      const dropped = await talk("Hal", NOW - 1500, "Here's the contract.", true);
      await summarize(dropped, 7, nothing);
      await ingest({ date: NOW - 1000, providerMsgId: "Hal-in-2", providerThreadId: "Hal", from: { name: "Hal", email: "hal@people.test" }, subject: "Re: About Hal", inReplyTo: "Hal-in", bodyText: "Can you sign it today?" }, true, NOW + 2);
      const queued = await store.aiSummaries.get(dropped);
      expect(queued?.state).toBe("pending");
      await store.aiSummaries.drop(dropped, queued!.throughMessageId);
      expect(await store.aiSummaries.get(dropped)).toMatchObject({ state: "ready", throughMessageId: queued!.throughMessageId });

      const all = [ack, ackAsks, told, asked, older, malformed, stale, dropped];
      expect((await store.threads.summaries(all)).every((t) => t.waitingSince != null)).toBe(true);
      const kept = [ackAsks, asked, older, malformed, stale, dropped];
      expect(new Set(await store.today.waitingAmong(all, NOW))).toEqual(new Set(kept));
      expect(new Set((await store.today.waitingPage({ now: NOW, after: null, limit: 20 })).map((p) => p.id))).toEqual(new Set(kept));
      expect(await store.today.needsCount(NOW)).toBe(kept.length);
      expect((await store.today.countWith([], NOW)).needs).toBe(kept.length);
    });

    it("Codex code review: a request you've handled from their latest message (Done, Not a task, Later) isn't waiting on you", async () => {
      const { store } = await setup();
      const DAY = 86_400_000;
      const ingest = async (m: Partial<IncomingMessage>, dated = false) =>
        (await store.sync.ingest([msg({ listId: null, isRead: false, to: [me], ...m, accountId: accountId_() })], { applyFilters: false, now: NOW, classifier: null, ...(dated ? { datedMail: { since: null } } : {}) })).inserted[0]!;
      /** their request, answering yours, with a dated item read from it */
      const asked = async (name: string, date: number) => {
        const email = `${name.toLowerCase()}@people.test`;
        await ingest({ date: date - 500, providerMsgId: `${name}-out`, providerThreadId: name, from: me, to: [{ name, email }], isSent: true, isRead: true, subject: `About ${name}` });
        const message = await ingest({ date, providerMsgId: `${name}-in`, providerThreadId: name, from: { name, email }, subject: `Re: About ${name}`, inReplyTo: `${name}-out`, bodyText: "Please send the report by Friday." }, true);
        const thread = await threadOf(store, `${name}-in`);
        await store.dated.finish({ messageId: message, threadId: thread, fromScan: false, settled: [], now: NOW, model: "m", provider: "p", promptVersion: 4, clearGeneration: store.dated.clearGeneration(),
          rows: [{ kind: "respond", item: 0, text: "Send the report", quote: "by Friday", dueDay: "2026-11-06", dueAt: NOW + DAY, timed: false, dated: true, actAt: NOW }] });
        const [item] = await store.dated.ofThread(thread);
        return { thread, item: item! };
      };
      const done = await asked("Ivy", NOW - 9000);
      const later = await asked("Jon", NOW - 8000);
      const answered = await asked("Kim", NOW - 7000);
      const open = await asked("Lou", NOW - 6000);
      const all = [done.thread, later.thread, answered.thread, open.thread];
      expect(new Set(await store.today.waitingAmong(all, NOW))).toEqual(new Set(all));

      const was = (await store.dated.update(done.item.id, done.item.revision, { state: "done", closedAt: NOW }))!;
      await store.dated.update(later.item.id, later.item.revision, { deferredUntil: NOW + DAY });
      await store.dated.update(answered.item.id, answered.item.revision, { state: "dismissed", closedAt: NOW });
      // something newer from them: waiting again, whatever was handled before it
      await ingest({ date: NOW - 500, providerMsgId: "Kim-in-2", providerThreadId: "Kim", from: { name: "Kim", email: "kim@people.test" }, subject: "Re: About Kim", inReplyTo: "Kim-in", bodyText: "Also, the slides?" });
      expect(new Set(await store.today.waitingAmong(all, NOW))).toEqual(new Set([answered.thread, open.thread]));
      expect(await store.today.needsCount(NOW)).toBe(2);
      // Later's time comes: back
      expect(new Set(await store.today.waitingAmong(all, NOW + 2 * DAY))).toEqual(new Set([later.thread, answered.thread, open.thread]));
      // Undo: the item as it was, and the conversation with it
      expect(await store.dated.restore([{ snapshot: was, expectRevision: done.item.revision + 1 }])).toBe(1);
      expect(new Set(await store.today.waitingAmong(all, NOW))).toEqual(new Set([done.thread, answered.thread, open.thread]));
    });

    it("Codex code review (round 4): a promise you've closed since their latest message, or a message saying no answer is needed, isn't waiting on you", async () => {
      const { store } = await setup();
      const DAY = 86_400_000;
      const ingest = async (m: Partial<IncomingMessage>, liveSent = false) =>
        (await store.sync.ingest([msg({ listId: null, isRead: false, to: [me], ...m, accountId: accountId_() })], { applyFilters: false, now: NOW, classifier: null, ...(liveSent ? { liveSent: { wanted: true } } : {}) })).inserted[0]!;
      /** you wrote and promised (follow-ups read it: it's marked), they wrote back */
      const owed = async (name: string, date: number, reply = "Any news on the report?") => {
        const email = `${name.toLowerCase()}@people.test`;
        const sent = await ingest({ date: date - 500, providerMsgId: `${name}-out`, providerThreadId: name, from: me, to: [{ name, email }], isSent: true, inInbox: false, isRead: true, subject: `About ${name}`, bodyText: "I'll send the report Friday." }, true);
        await ingest({ date, providerMsgId: `${name}-in`, providerThreadId: name, from: { name, email }, subject: `Re: About ${name}`, inReplyTo: `${name}-out`, snippet: reply, bodyText: reply });
        const thread = await threadOf(store, `${name}-in`);
        await store.followups.finish({ messageId: sent, threadId: thread, fromScan: false, rows: [{ kind: "promise", item: 0, text: "send the report", quote: "I'll send the report", personName: name, personEmail: email, dueAt: NOW + DAY, dated: true }], kept: [], now: NOW, model: "m", provider: "p", promptVersion: 1, clearGeneration: store.followups.clearGeneration() });
        const promise = (await store.followups.active()).find((r) => r.threadId === thread)!;
        return { thread, promise };
      };
      const done = await owed("Ivy", NOW - 9000);
      const dismissed = await owed("Jon", NOW - 8000);
      const newer = await owed("Kim", NOW - 7000);
      const open = await owed("Lou", NOW - 6000);
      const fyi = await owed("Max", NOW - 5000, "Quick FYI: the promo code is live. No action needed! Max");
      const all = [done.thread, dismissed.thread, newer.thread, open.thread, fyi.thread];
      expect(new Set(await store.today.waitingAmong(all, NOW))).toEqual(new Set([done.thread, dismissed.thread, newer.thread, open.thread]));

      const was = (await store.followups.update(done.promise.id, done.promise.revision, { state: "done", closedReason: "user", closedAt: NOW, inboxState: "none" }))!;
      await store.followups.update(dismissed.promise.id, dismissed.promise.revision, { state: "dismissed", closedReason: "user", closedAt: NOW, inboxState: "none" });
      await store.followups.update(newer.promise.id, newer.promise.revision, { state: "done", closedReason: "user", closedAt: NOW - 6500, inboxState: "none" });
      // something newer from them after it closed: waiting again
      await ingest({ date: NOW - 500, providerMsgId: "Kim-in-2", providerThreadId: "Kim", from: { name: "Kim", email: "kim@people.test" }, subject: "Re: About Kim", inReplyTo: "Kim-in", bodyText: "And the slides?" });
      expect(new Set(await store.today.waitingAmong(all, NOW))).toEqual(new Set([newer.thread, open.thread]));
      expect(await store.today.needsCount(NOW)).toBe(2);
      // Undo: the promise as it was, and the conversation with it
      expect(await store.followups.restore([{ snapshot: was, expectRevision: was.revision + 1 }])).toBe(1);
      expect(new Set(await store.today.waitingAmong(all, NOW))).toEqual(new Set([done.thread, newer.thread, open.thread]));
      // two promises there and one closed: the other is still owed, so it's still waiting on you
      const deck = await ingest({ date: NOW - 6200, providerMsgId: "Lou-out-2", providerThreadId: "Lou", from: me, to: [{ name: "Lou", email: "lou@people.test" }], isSent: true, inInbox: false, isRead: true, subject: "Re: About Lou", bodyText: "And I'll send the deck." }, true);
      await store.followups.finish({ messageId: deck, threadId: open.thread, fromScan: false, rows: [{ kind: "promise", item: 0, text: "send the deck", quote: "I'll send the deck", personName: "Lou", personEmail: "lou@people.test", dueAt: NOW + 2 * DAY, dated: true }], kept: [], now: NOW, model: "m", provider: "p", promptVersion: 1, clearGeneration: store.followups.clearGeneration() });
      await store.followups.update(open.promise.id, open.promise.revision, { state: "done", closedReason: "user", closedAt: NOW, inboxState: "none" });
      expect(await store.today.waitingAmong([open.thread], NOW)).toEqual([open.thread]);

      // plan 204 (the fifth panel round): its only open promise put off with Later isn't waiting until it's back; Undo, or
      // another open promise there, and it is
      const fresh = await owed("Ned", NOW - 4000);
      const later = (await store.followups.update(fresh.promise.id, fresh.promise.revision, { state: "open", inboxState: "none", deferredUntil: NOW + DAY }))!;
      expect(await store.today.waitingAmong([fresh.thread], NOW)).toEqual([]);
      expect(await store.today.waitingAmong([fresh.thread], NOW + DAY)).toEqual([fresh.thread]);
      const count = await store.today.needsCount(NOW);
      expect(await store.followups.restore([{ snapshot: later, expectRevision: later.revision + 1 }])).toBe(1);
      expect(await store.today.waitingAmong([fresh.thread], NOW)).toEqual([fresh.thread]);
      expect(await store.today.needsCount(NOW)).toBe(count + 1);
      const deferredLou = (await store.followups.ofThread(open.thread)).find((r) => r.state === "open")!;
      await store.followups.update(deferredLou.id, deferredLou.revision, { deferredUntil: NOW + DAY });
      expect(await store.today.waitingAmong([open.thread], NOW)).toEqual([]);
      await ingest({ date: NOW - 6100, providerMsgId: "Lou-out-3", providerThreadId: "Lou", from: me, to: [{ name: "Lou", email: "lou@people.test" }], isSent: true, inInbox: false, isRead: true, subject: "Re: About Lou", bodyText: "Also the budget." }, true);
      const budget = (await store.followups.marks.page(null, 10)).at(-1)!.messageId;
      await store.followups.finish({ messageId: budget, threadId: open.thread, fromScan: false, rows: [{ kind: "promise", item: 0, text: "send the budget", quote: "Also the budget", personName: "Lou", personEmail: "lou@people.test", dueAt: NOW + 3 * DAY, dated: true }], kept: [], now: NOW, model: "m", provider: "p", promptVersion: 1, clearGeneration: store.followups.clearGeneration() });
      expect(await store.today.waitingAmong([open.thread], NOW)).toEqual([open.thread]);
    });

    it("digestLive: only what's in the Inbox and unread", async () => {
      const { store, put } = await setup();
      const a = await put();
      const b = await put();
      const c = await put();
      await store.threads.act({ threadIds: [b.thread], action: "archive", signal: null, now: NOW });
      await store.threads.act({ threadIds: [c.thread], action: "markRead", signal: null, now: NOW });
      expect(await store.today.digestLive([a.thread, b.thread, c.thread])).toEqual([a.thread]);
      // plan 161: the read one is still in the Inbox, kept: the page says so on its row
      expect(await store.today.digestRead([a.thread, b.thread, c.thread])).toEqual([c.thread]);
    });

    describe("the digest's row", () => {
      const item = { threadId: 1, messageId: 2, lastDate: 3, messageCount: 1, from: "F", subject: "S", line: null };

      it("begins once, is checkpointed, and is found by day", async () => {
        const { digest } = (await setup()).store.today;
        const g = digest.clearGeneration();
        expect(await digest.begin("2026-11-05", { at: 10, id: 20 }, [item], g)).toBe(true);
        expect(await digest.begin("2026-11-05", { at: 11, id: 21 }, [], g)).toBe(false);
        const row = (await digest.get("2026-11-05"))!;
        expect(row).toMatchObject({ state: "pending", pending: [item], items: [], watermark: { at: 10, id: 20 } });
        expect(await digest.pendingDays()).toEqual(["2026-11-05"]);
        expect(await digest.write({ ...row, pending: [], items: [{ ...item, line: "A line" }], state: "ready", model: "m", provider: "p", promptVersion: 1, generatedAt: 5 }, g)).toBe(true);
        expect(await digest.pendingDays()).toEqual([]);
        expect((await digest.latest("2026-11-09"))?.items[0]?.line).toBe("A line");
        expect(await digest.latest("2026-11-04")).toBeNull();
      });

      it("prunes the old, and a clear refuses what began before it", async () => {
        const { digest } = (await setup()).store.today;
        const g = digest.clearGeneration();
        await digest.begin("2026-10-01", { at: 0, id: 0 }, [], g);
        await digest.begin("2026-11-05", { at: 0, id: 0 }, [], g);
        await digest.prune("2026-10-22");
        expect(await digest.get("2026-10-01")).toBeNull();
        const row = (await digest.get("2026-11-05"))!;
        await digest.clear();
        expect(await digest.get("2026-11-05")).toBeNull();
        expect(await digest.write(row, g)).toBe(false);
        expect(await digest.begin("2026-11-05", { at: 0, id: 0 }, [], g)).toBe(false);
      });
    });
  });
}
