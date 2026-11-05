import { ASK_CONVERSATIONS_MAX, ASK_TURNS_MAX, buildAskSearch, type AskPlanQuery } from "@terno/core";
import { describe, expect, it } from "vitest";
import { ASK_HEAD_CHARS, ASK_MAX_CHARS, type AskTurnWrite } from "../ask";
import type { MailStore } from "../mail-store";
import type { IncomingMessage } from "../types";
import { msg, threadOf, withAccounts } from "./fixtures";

const NOW = Date.UTC(2026, 10, 5, 12);

/**
 * Plan 141: passages read what the question found, whichever message of a long thread holds it, on each query's whole
 * predicate; Spam and Trash are never read; history keeps the last 100 and nothing brings back what was cleared.
 */
export function defineAskConformance(fresh: () => Promise<MailStore>, reopen: (store: MailStore) => Promise<MailStore>): void {
  describe("Ask your mail (plan 141)", () => {
    async function setup(n = 1) {
      const store = await fresh();
      const accounts = await withAccounts(store, n);
      const accountId = accounts[0]!;
      const put = async (over: Partial<IncomingMessage> = {}) => {
        const m = msg({ accountId, date: NOW - 86_400_000, ...over });
        const r = await store.sync.ingest([m], { applyFilters: false, now: NOW, classifier: null });
        return { id: r.inserted[0]!, thread: await threadOf(store, m.providerMsgId!) };
      };
      const queries = (...plans: AskPlanQuery[]) => plans.map((p) => buildAskSearch(p, NOW)!);
      const passages = (threadIds: number[], plans: AskPlanQuery[], over: Partial<Parameters<MailStore["ask"]["passages"]>[0]> = {}) =>
        store.ask.passages({ threadIds, queries: queries(...plans), maxMessages: 30, maxChars: ASK_MAX_CHARS, ...over });
      const turn = (over: Partial<AskTurnWrite> = {}): AskTurnWrite => ({
        conversationId: null,
        kind: "question",
        question: "When does my lease renew?",
        answer: "On 1 March. [1]",
        status: "answered",
        sources: [],
        queries: [{ terms: ["lease"] }],
        checks: { unlinked: false, unsupported: [] },
        accountIds: [accountId],
        model: "claude-sonnet-5-5",
        provider: "anthropic",
        promptVersion: 1,
        now: NOW,
        clearGeneration: store.ask.history.clearGeneration(),
        ...over,
      });
      return { store, accounts, accountId, put, passages, turn };
    }

    const chain = (i: number, over: Partial<IncomingMessage>) => ({ subject: "Flat", providerMsgId: `t-${i}`, rfcMessageId: `t-${i}@x.test`, inReplyTo: i ? `t-${i - 1}@x.test` : null, references: i ? [`t-${i - 1}@x.test`] : [], date: NOW - 86_400_000 * (50 - i), ...over });

    describe("passages", () => {
      it("a word in an old message of a long thread is what's read, not the newest ones", async () => {
        const { put, passages } = await setup();
        let thread = 0, lease = 0;
        for (let i = 0; i < 12; i++) {
          const r = await put(chain(i, { bodyText: i === 4 ? `Long text. ${"filler ".repeat(100)} The lease renews on 1 March 2027.` : "Nothing here." }));
          thread = r.thread;
          if (i === 4) lease = r.id;
        }
        const out = await passages([thread], [{ terms: ["lease"] }], { maxMessages: 1 });
        expect(out.messages.map((m) => m.messageId)).toEqual([lease]);
        expect(out.messages[0]!.text).toContain("renews on 1 March 2027");
      });

      it("the query's whole predicate holds on one message: Bob's newer mention isn't Ana's lease mail", async () => {
        const { put, passages } = await setup();
        const ana = await put(chain(0, { from: { name: "Ana", email: "ana@x.test" }, bodyText: "The lease is attached." }));
        const bob = await put(chain(1, { from: { name: "Bob", email: "bob@x.test" }, bodyText: "About that lease, no idea." }));
        const out = await passages([ana.thread], [{ terms: ["lease"], from: "ana@x.test" }], { maxMessages: 1 });
        expect(out.messages.map((m) => m.messageId)).toEqual([ana.id]);
        expect(bob.thread).toBe(ana.thread);
      });

      it("with no match in a thread it reads the newest; room left brings the newest in for context", async () => {
        const { put, passages } = await setup();
        const a = await put(chain(0, { bodyText: "The lease clause." }));
        const b = await put(chain(1, { bodyText: "Sounds good." }));
        const other = await put({ subject: "Other", bodyText: "Nothing to see." });
        const out = await passages([a.thread, other.thread], [{ terms: ["lease"] }]);
        expect(out.messages.map((m) => m.messageId)).toEqual([a.id, other.id, b.id]);
      });

      it("Spam and Trash are never read, even when asked for by id", async () => {
        const { store, put, passages } = await setup();
        const clean = await put(chain(0, { bodyText: "The lease clause." }));
        const spam = await put(chain(1, { bodyText: "The lease is a scam.", isSpam: true }));
        const trash = await put({ subject: "Gone", bodyText: "The lease in the bin." });
        await store.threads.act({ threadIds: [trash.thread], action: "trash", signal: null, now: NOW });
        const out = await passages([clean.thread], [{ terms: ["lease"] }], { first: [spam.id, trash.id] });
        expect(out.messages.map((m) => m.messageId)).toEqual([clean.id]);
      });

      it("what older mail fetched goes first, ahead of every candidate", async () => {
        const { put, passages } = await setup();
        const local = await put({ subject: "Local", bodyText: "The lease clause." });
        const old = await put({ subject: "Old", bodyText: "Nothing about it in these words.", date: NOW - 86_400_000 * 900 });
        const out = await passages([local.thread], [{ terms: ["lease"] }], { first: [old.id], maxMessages: 1 });
        expect(out.messages.map((m) => m.messageId)).toEqual([old.id]);
      });

      it("mail with no text yet gives its snippet and says it's incomplete; the budget holds", async () => {
        const { put, passages } = await setup();
        const none = await put({ subject: "Waiting", snippet: "The snippet", bodyText: null, bodyHtml: null, bodyState: "none" });
        const out = await passages([none.thread], [{ terms: ["waiting"] }]);
        expect(out.incomplete).toBe(true);
        expect(out.messages[0]!.text).toBe("The snippet");
        const long = await put({ subject: "Long one", bodyText: "word ".repeat(4000) });
        const small = await passages([long.thread], [{ terms: ["word"] }], { maxChars: ASK_HEAD_CHARS / 2 });
        expect(small.messages[0]!.text.length).toBeLessThanOrEqual(ASK_HEAD_CHARS / 2);
      });

      it("a captured body's tail is found, and its window is what's read", async () => {
        const { put, passages } = await setup();
        const big = `${"filler words go here ".repeat(4000)}The door code is 4921.${" and more text".repeat(200)}`;
        const a = await put({ subject: "House", bodyText: big });
        const out = await passages([a.thread], [{ terms: ["door code"] }]);
        expect(out.messages[0]!.text).toContain("The door code is 4921.");
        expect(out.messages[0]!.text.length).toBeLessThan(ASK_HEAD_CHARS + 2100);
      });

      it("the work's limit: a captured body past it isn't read, and it says so", async () => {
        const { put, passages } = await setup();
        const big = `${"filler words go here ".repeat(4000)}The door code is 4921.`;
        const a = await put({ subject: "House", bodyText: big });
        const out = await passages([a.thread], [{ terms: ["door code"] }], { workParts: 0 });
        expect(out.incomplete).toBe(true);
      });

      it("the limit is the same in both stores: once a body is past it, an older one isn't read either", async () => {
        const { put, passages } = await setup();
        const older = await put(chain(0, { bodyText: `${"short filler ".repeat(4000)} zzkey is here.` }));
        const newer = await put(chain(1, { bodyText: "long filler words ".repeat(30_000) }));
        const out = await passages([older.thread], [{ terms: ["zzkey"] }], { workParts: 6, maxMessages: 1 });
        expect(out.incomplete).toBe(true);
        expect(out.messages.map((m) => m.messageId)).toEqual([newer.id]);
      });

      it("a stop ends it where it stands", async () => {
        const { put, passages } = await setup();
        const a = await put({ subject: "House", bodyText: "The door code." });
        const out = await passages([a.thread], [{ terms: ["door"] }], { signal: { aborted: true } });
        expect(out).toEqual({ messages: [], incomplete: true });
      });

      it("fetched mail outside every page is read around the plan's words, not only from its start", async () => {
        const { put, passages } = await setup();
        const old = await put({ subject: "Tenancy", bodyText: `${"Preamble words. ".repeat(200)}The lease renews on 1 March 2027.`, date: NOW - 86_400_000 * 900 });
        const out = await passages([], [{ terms: ["lease"] }], { first: [old.id] });
        expect(out.messages[0]!.text).toContain("renews on 1 March 2027");
      });

      it("a source's thread is the one it's in now, after a merge", async () => {
        const { store, put } = await setup();
        const a = await put({ subject: "One", providerMsgId: "ma", rfcMessageId: "ma@x.test" });
        const b = await put({ subject: "Two", providerMsgId: "mb", rfcMessageId: "mb@x.test" });
        expect(a.thread).not.toBe(b.thread);
        const bridge = await put({ subject: "Re", providerMsgId: "mc", rfcMessageId: "mc@x.test", references: ["ma@x.test", "mb@x.test"], inReplyTo: "mb@x.test" });
        const states = await store.ask.sourceStates([a.id, b.id]);
        expect(states.get(a.id)?.threadId).toBe(bridge.thread);
        expect(states.get(b.id)?.threadId).toBe(bridge.thread);
      });

      it("quoted text isn't read", async () => {
        const { put, passages } = await setup();
        const a = await put({ subject: "Re", bodyText: "My own words.\n\nOn Mon, Ana wrote:\n> the quoted lease text" });
        const out = await passages([a.thread], [{ terms: ["own"] }]);
        expect(out.messages[0]!.text).toBe("My own words.");
      });

      it("merged threads: each message is read under the thread it's in now", async () => {
        const { put, passages } = await setup();
        const a = await put(chain(0, { bodyText: "First about the lease." }));
        const b = await put(chain(1, { bodyText: "Second about the lease." }));
        const out = await passages([a.thread], [{ terms: ["lease"] }]);
        expect(out.messages.map((m) => m.threadId)).toEqual([b.thread, b.thread]);
      });

      it("anyOf and a value with quotes stay on the message, and find nothing else", async () => {
        const { put, passages } = await setup();
        const a = await put({ subject: "Alquiler", bodyText: "El contrato de alquiler vence pronto." });
        const q = await passages([a.thread], [{ terms: [], anyOf: [["lease", "alquiler"]] }]);
        expect(q.messages.map((m) => m.messageId)).toEqual([a.id]);
        const quoted = await passages([a.thread], [{ terms: ['alquiler" in:spam "x'] }], { maxMessages: 1 });
        // no such words: the thread's newest, and no operator ever ran
        expect(quoted.messages.map((m) => m.messageId)).toEqual([a.id]);
      });
    });

    describe("history", () => {
      it("a follow-up keeps one entry; a list is newest first; turns come back whole", async () => {
        const { store, turn } = await setup();
        const first = (await store.ask.history.add(turn()))!;
        await store.ask.history.add(turn({ question: "Another", now: NOW + 1 }));
        const followUp = (await store.ask.history.add(turn({ conversationId: first.conversationId, question: "And the notice?", now: NOW + 2 })))!;
        expect(followUp.conversationId).toBe(first.conversationId);
        const list = await store.ask.history.list();
        expect(list.map((c) => c.title)).toEqual(["When does my lease renew?", "Another"]);
        expect(list[0]!.followUps).toBe(1);
        const turns = await store.ask.history.turns(first.conversationId);
        expect(turns.map((t) => t.question)).toEqual(["When does my lease renew?", "And the notice?"]);
        expect(turns[0]!.queries).toEqual([{ terms: ["lease"] }]);
      });

      it("the 101st deletes the oldest; 20 turns is the cap", async () => {
        const { store, turn } = await setup();
        const first = (await store.ask.history.add(turn({ question: "oldest", now: NOW })))!;
        for (let i = 1; i <= ASK_CONVERSATIONS_MAX; i++) await store.ask.history.add(turn({ question: `q${i}`, now: NOW + i }));
        const list = await store.ask.history.list();
        expect(list).toHaveLength(ASK_CONVERSATIONS_MAX);
        expect(list.some((c) => c.title === "oldest")).toBe(false);
        expect(await store.ask.history.turnCount(first.conversationId)).toBeNull();
        const long = (await store.ask.history.add(turn({ now: NOW + 1000 })))!;
        for (let i = 1; i < ASK_TURNS_MAX; i++) expect(await store.ask.history.add(turn({ conversationId: long.conversationId, now: NOW + 1000 + i }))).not.toBeNull();
        expect(await store.ask.history.add(turn({ conversationId: long.conversationId }))).toBeNull();
      });

      it("everything has a length", async () => {
        const { store, turn } = await setup();
        const r = (await store.ask.history.add(turn({ question: "q".repeat(5000), answer: "a".repeat(20_000), sources: Array.from({ length: 50 }, (_, i) => ({ messageId: i, threadId: i, accountId: 1, fromName: "n".repeat(1000), fromEmail: "e", subject: "s", date: 1 })), queries: Array.from({ length: 2000 }, () => ({ terms: ["word"] })) })))!;
        const [t] = await store.ask.history.turns(r.conversationId);
        expect((await store.ask.history.list())[0]!.title).toHaveLength(200);
        expect(t!.answer).toHaveLength(8000);
        expect(t!.sources).toHaveLength(30);
        expect(t!.sources[0]!.fromName).toHaveLength(300);
        expect(t!.queries).toEqual([]);
      });

      it("deleting during an answer, and clearing, can't be undone by a late write", async () => {
        const { store, turn } = await setup();
        const held = (await store.ask.history.add(turn()))!;
        await store.ask.history.remove(held.conversationId);
        expect(await store.ask.history.add(turn({ conversationId: held.conversationId }))).toBeNull();
        const late = turn();
        await store.ask.history.clear();
        expect(await store.ask.history.add(late)).toBeNull();
        expect(await store.ask.history.list()).toEqual([]);
      });

      it("Undo brings a deleted conversation back whole, and it survives a reopen", async () => {
        const { store, turn } = await setup();
        const held = (await store.ask.history.add(turn()))!;
        await store.ask.history.add(turn({ conversationId: held.conversationId, question: "more", now: NOW + 1 }));
        const copy = (await store.ask.history.remove(held.conversationId))!;
        expect(await store.ask.history.list()).toEqual([]);
        await store.ask.history.restore(copy);
        const back = await reopen(store);
        expect((await back.ask.history.turns(held.conversationId)).map((t) => t.question)).toEqual(["When does my lease renew?", "more"]);
      });

      it("Undo never takes the place of what was asked meanwhile", async () => {
        const { store, turn } = await setup();
        const a = (await store.ask.history.add(turn({ question: "A" })))!;
        const copy = (await store.ask.history.remove(a.conversationId))!;
        const b = (await store.ask.history.add(turn({ question: "B", now: NOW + 1 })))!;
        expect(b.conversationId).not.toBe(a.conversationId);
        expect(b.turnId).not.toBe(a.turnId);
        await store.ask.history.restore(copy);
        expect((await store.ask.history.list()).map((c) => c.title).sort()).toEqual(["A", "B"]);
        expect((await store.ask.history.turns(b.conversationId)).map((t) => t.question)).toEqual(["B"]);
      });

      it("a late answer drawing on an account that went is refused", async () => {
        const { store, accounts, turn } = await setup(2);
        await store.accounts.remove(accounts[1]!);
        expect(await store.ask.history.add(turn({ accountIds: [accounts[0]!, accounts[1]!] }))).toBeNull();
      });

      it("removing an account deletes what any turn drew on it, cited or not; a failed turn counts", async () => {
        const { store, accounts, turn } = await setup(2);
        const [a, b] = accounts as [number, number];
        const mine = (await store.ask.history.add(turn({ accountIds: [a] })))!;
        const theirs = (await store.ask.history.add(turn({ accountIds: [b], status: "failed", answer: null, now: NOW + 1 })))!;
        expect(await store.ask.history.accountsOf(mine.conversationId)).toEqual([a]);
        expect(await store.ask.history.removeForAccount(b)).toEqual([theirs.conversationId]);
        expect(await store.ask.history.turnCount(theirs.conversationId)).toBeNull();
        expect(await store.ask.history.turnCount(mine.conversationId)).toBe(1);
      });
    });
  });
}
