import type { Address } from "@terno/core";
import { describe, expect, it } from "vitest";
import { AWAITING_ITEM } from "../followups";
import type { MailStore } from "../mail-store";
import type { IncomingMessage } from "../types";
import { backfillFacts, msg, threadOf, withAccounts } from "./fixtures";

const NOW = Date.UTC(2026, 10, 5, 12);
const me: Address = { name: "Me", email: "me0@example.com" };
const ana: Address = { name: "Ana", email: "ana@example.com" };
const rule = { match: "all" as const, conditions: [{ field: "subject" as const, op: "contains" as const, value: "invoice" }], actions: [{ type: "markRead" as const }] };

/** Plan 153: mail in Spam triggers nothing, in both stores. */
export function defineSpamConformance(fresh: () => Promise<MailStore>): void {
  describe("spam triggers nothing (plan 153)", () => {
    async function setup() {
      const store = await fresh();
      const [accountId] = await withAccounts(store, 1);
      let seq = 0;
      const put = async (over: Partial<IncomingMessage> = {}) => {
        const providerMsgId = `s-${seq++}`;
        const m = msg({ accountId: accountId!, providerMsgId, date: NOW - 10 * 60_000 + seq * 1000, from: ana, to: [me], ...over });
        const r = await store.sync.ingest([m], { applyFilters: false, now: NOW, classifier: null });
        return { id: r.inserted[0]!, thread: await threadOf(store, providerMsgId), m };
      };
      return { store, put, accountId_: () => accountId! };
    }
    const spam = { isSpam: true, inInbox: false };

    it("a filter or a sentence's scan never matches a message in Spam", async () => {
      const { store, put } = await setup();
      const kept = await put({ subject: "invoice 1" });
      const junk = await put({ subject: "invoice 2", ...spam });
      expect(await store.filters.matchMessages(rule, NOW, [kept.id, junk.id])).toEqual([kept.id]);
    });

    it("a spam message doesn't raise a conversation's unread; the Spam folder still reads unread", async () => {
      const { store, put } = await setup();
      const first = await put({ isRead: true, providerThreadId: "mixed" });
      await put({ providerThreadId: "mixed", ...spam });
      expect((await store.threads.summaries([first.thread]))[0]).toMatchObject({ unread: false, inInbox: true });
      const all = await put(spam);
      expect((await store.threads.summaries([all.thread]))[0]).toMatchObject({ unread: true, inSpam: true });
    });

    it("sent mail in Spam teaches nothing about who you write to", async () => {
      const { store, put } = await setup();
      await put({ from: me, to: [{ name: "", email: "stranger@spoof.test" }], isSent: true, ...spam });
      await put({ from: { name: "Stranger", email: "stranger@spoof.test" } });
      await backfillFacts(store);
      expect(await store.today.needsCount(NOW)).toBe(0);
      // the same mail outside Spam does: what holds this down is the gate
      await put({ from: me, to: [{ name: "", email: "real@friend.test" }], isSent: true, inInbox: false });
      await put({ from: { name: "Friend", email: "real@friend.test" } });
      expect(await store.today.needsCount(NOW)).toBe(1);
    });

    it("your address on a spam message answers nothing: the conversation still waits", async () => {
      const { store, put } = await setup();
      const asked = await put({ rfcMessageId: "asked@test" });
      await put({ from: me, to: [ana], references: ["asked@test"], inReplyTo: "asked@test", isSent: true, providerThreadId: "elsewhere", ...spam });
      await backfillFacts(store);
      expect((await store.threads.summaries([asked.thread]))[0]!.waitingSince).not.toBeNull();
    });

    it("your reply moving to Spam reopens what it answered", async () => {
      const { store, put, accountId_ } = await setup();
      const asked = await put({ rfcMessageId: "reopen@test" });
      const reply = await put({ from: me, to: [ana], references: ["reopen@test"], inReplyTo: "reopen@test", isSent: true, inInbox: false, providerThreadId: "elsewhere-2" });
      await backfillFacts(store);
      expect((await store.threads.summaries([asked.thread]))[0]!.waitingSince).toBeNull();
      await store.sync.updateFlags(accountId_(), [{ messageId: reply.id, flags: { isSpam: true } }]);
      expect((await store.threads.summaries([asked.thread]))[0]!.waitingSince).not.toBeNull();
    });

    it("sent mail in Spam doesn't stop a follow-up from waiting", async () => {
      const { store, put, accountId_ } = await setup();
      const asked = msg({ accountId: accountId_(), providerMsgId: "wait-1", from: me, to: [ana], isSent: true, inInbox: false, providerThreadId: "wait", isRead: true, date: NOW - 60_000 });
      const { inserted } = await store.sync.ingest([asked], { applyFilters: false, now: NOW, classifier: null, liveSent: { wanted: true } });
      await put({ from: me, to: [ana], isSent: true, providerThreadId: "wait", date: NOW - 1000, ...spam });
      const thread = await threadOf(store, "wait-1");
      const write = { kind: "awaiting" as const, item: AWAITING_ITEM, text: "", quote: null, personName: "Ana", personEmail: ana.email, dueAt: NOW + 86_400_000, dated: false };
      await store.followups.finish({ messageId: inserted[0]!, threadId: thread, fromScan: false, rows: [write], kept: [], now: NOW, model: "m", provider: "p", promptVersion: 1, clearGeneration: store.followups.clearGeneration() });
      expect(await store.followups.ofThread(thread)).toHaveLength(1);
    });

    it("no unsubscribe offer comes from a spam message", async () => {
      const { store, put } = await setup();
      const junk = await put({ ...spam, unsubscribe: "https://spam.test/out" } as Partial<IncomingMessage>);
      expect(await store.threads.unsubscribeSource(junk.thread)).toBeNull();
    });
  });
}
