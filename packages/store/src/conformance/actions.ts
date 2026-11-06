import { describe, expect, it } from "vitest";
import type { MailStore } from "../mail-store";
import type { IncomingMessage } from "../types";
import { msg, threadOf, withAccounts } from "./fixtures";

const NOW = Date.UTC(2026, 10, 5, 12);

/** Plan 143: one walk through the mailbox, and what a preview needs of a thread, the same in both stores. */
export function defineActionsConformance(fresh: () => Promise<MailStore>): void {
  describe("Sentences' previews (plan 143)", () => {
    async function setup() {
      const store = await fresh();
      const [accountId] = await withAccounts(store, 1);
      let seq = 0;
      const put = async (over: Partial<IncomingMessage> = {}) => {
        const m = msg({ date: NOW - 1000, providerMsgId: `a-${seq++}`, ...over, accountId: accountId! });
        const r = await store.sync.ingest([m], { applyFilters: false, now: NOW, classifier: null });
        return { message: r.inserted[0]!, thread: await threadOf(store, m.providerMsgId!) };
      };
      return { store, accountId: accountId!, put };
    }

    it("a walk goes through every message once, newest first, in the pages asked for, and doesn't start over", async () => {
      const { store, put } = await setup();
      const ids: number[] = [];
      for (let i = 0; i < 7; i++) ids.push((await put()).message);
      const walk = store.filters.messageWalk();
      const seen: number[][] = [];
      for (;;) {
        const page = await walk.next(3);
        if (!page.length) break;
        seen.push(page);
      }
      expect(seen.map((p) => p.length)).toEqual([3, 3, 1]);
      expect(seen.flat()).toEqual([...ids].sort((a, b) => b - a));
      expect(await walk.next(3)).toEqual([]);
    });

    it("what a rule matches comes down to its threads, once each", async () => {
      const { store, put } = await setup();
      const a = await put({ providerThreadId: "t", subject: "One" });
      const b = await put({ providerThreadId: "t", subject: "Re: One", inReplyTo: null });
      const c = await put({ subject: "Other" });
      const threads = await store.filters.threadsOf([a.message, b.message, c.message]);
      expect(new Set(threads)).toEqual(new Set([a.thread, c.thread]));
      expect(threads).toHaveLength(new Set(threads).size);
    });

    it("facts say what the thread holds, and a nameless sender's name is empty, never the address", async () => {
      const { store, accountId, put } = await setup();
      const { thread } = await put({ from: { name: "", email: "x@acme.test" }, subject: "Hello", isRead: false });
      const [f] = await store.filters.actionFacts([thread]);
      expect(f).toMatchObject({ id: thread, accountId, subject: "Hello", lastFromName: "", lastFromEmail: "x@acme.test", messageCount: 1, unread: true, starred: false, replied: false, inInbox: true, inTrash: false, inSpam: false, inCategory: false });
      expect(await store.filters.actionFacts([thread + 9999])).toEqual([]);
    });

    it("facts follow the thread: starred, trashed, spam, and in the category asked about", async () => {
      const { store, put } = await setup();
      const a = await put();
      const b = await put();
      const c = await put();
      await store.threads.act({ threadIds: [a.thread], action: "star", signal: null, now: NOW });
      await store.threads.act({ threadIds: [b.thread], action: "trash", signal: null, now: NOW });
      await store.threads.act({ threadIds: [c.thread], action: "spam", signal: null, now: NOW });
      const category = await store.categories.create("Work", "rose", {});
      expect(await store.categories.hasThreads(category.id)).toBe(false);
      await store.categories.add({ categoryId: category.id, threadIds: [a.thread], addedBy: "bulk", now: NOW, batchId: null });
      expect(await store.categories.hasThreads(category.id)).toBe(true);
      const byId = new Map((await store.filters.actionFacts([a.thread, b.thread, c.thread], category.id)).map((f) => [f.id, f]));
      expect(byId.get(a.thread)).toMatchObject({ starred: true, inCategory: true });
      expect(byId.get(b.thread)).toMatchObject({ inTrash: true, inCategory: false });
      expect(byId.get(c.thread)).toMatchObject({ inSpam: true });
    });

    it("the same rule, through a walk, finds the same messages as its windows", async () => {
      const { store, put } = await setup();
      const hit = await put({ subject: "Shipping 12", date: NOW - 40 * 86_400_000 });
      await put({ subject: "Shipping 13" });
      await put({ subject: "Other", date: NOW - 40 * 86_400_000 });
      const rule = { match: "all" as const, conditions: [{ field: "subject" as const, op: "matches" as const, value: "shipping" }, { field: "ageDays" as const, op: "gt" as const, value: 30 }], actions: [{ type: "archive" as const }] };
      const walk = store.filters.messageWalk();
      expect(await store.filters.matchMessages(rule, NOW, await walk.next(100))).toEqual([hit.message]);
    });
  });
}
