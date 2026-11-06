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
      const next = await store.today.waitingPage({ now: NOW, after: page[0]!, limit: 5 });
      expect(next.map((p) => p.id)).toEqual([a.thread]);
      expect(new Set(await store.today.waitingAmong([a.thread, b.thread, notice.thread, calendar.thread, 999_999], NOW))).toEqual(new Set(waiting));
      expect(await store.today.needsCount(NOW)).toBe(2);
    });

    it("digestLive: only what's in the Inbox and unread", async () => {
      const { store, put } = await setup();
      const a = await put();
      const b = await put();
      const c = await put();
      await store.threads.act({ threadIds: [b.thread], action: "archive", signal: null, now: NOW });
      await store.threads.act({ threadIds: [c.thread], action: "markRead", signal: null, now: NOW });
      expect(await store.today.digestLive([a.thread, b.thread, c.thread])).toEqual([a.thread]);
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
