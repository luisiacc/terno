import { describe, expect, it } from "vitest";
import { REPLY_BODIES_MAX, REPLY_DECISIONS_MAX } from "@terno/core";
import type { MailStore } from "../mail-store";
import { replyEvictions, type ReplyWrite } from "../replies";
import { msg, threadOf, withAccounts } from "./fixtures";

const NOW = Date.UTC(2026, 10, 5, 12);

/** Plan 144: a cached suggestion. Conditional on the thread as it was read, conditional on what was seen, and never a draft. */
export function defineRepliesConformance(fresh: () => Promise<MailStore>): void {
  describe("Prepared replies (plan 144)", () => {
    async function setup() {
      const store = await fresh();
      const [accountId] = await withAccounts(store, 1);
      const m = msg({ accountId: accountId!, date: NOW - 1000, providerMsgId: "r-1", providerThreadId: "t" });
      await store.sync.ingest([m], { applyFilters: false, now: NOW, classifier: null });
      const thread = await threadOf(store, "r-1");
      const stamp = (await store.aiSummaries.sources(thread))!.stamp;
      const write = (over: Partial<ReplyWrite> = {}): ReplyWrite => ({ threadId: thread, sourceStamp: stamp, generationKey: "k", answeringMessageId: 1, state: "ready", body: "Hello", used: null, checks: null, to: [{ name: "Ana", email: "ana@x.test" }], cc: [], model: "m", provider: "p", promptVersion: 1, generatedAt: NOW, clearGeneration: store.replies.clearGeneration(), ...over });
      return { store, accountId: accountId!, thread, stamp, write };
    }

    it("round trips, and isn't a draft or a count", async () => {
      const { store, thread, write } = await setup();
      const counts = await store.threads.counts(NOW);
      expect(await store.replies.finish(write())).toBe("written");
      expect(await store.replies.get(thread)).toMatchObject({ threadId: thread, generationKey: "k", state: "ready", body: "Hello", to: [{ name: "Ana", email: "ana@x.test" }], revision: 0 });
      expect(await store.drafts.list()).toEqual([]);
      expect(await store.threads.counts(NOW)).toEqual(counts);
    });

    it("a thread that moved since it was read refuses it, and Spam and Trash too", async () => {
      const { store, accountId, thread, write } = await setup();
      await store.sync.ingest([msg({ accountId, date: NOW, providerMsgId: "r-2", providerThreadId: "t" })], { applyFilters: false, now: NOW, classifier: null });
      expect(await store.replies.finish(write())).toBe("moved");
      expect(await store.replies.get(thread)).toBeNull();
      const stamp = (await store.aiSummaries.sources(thread))!.stamp;
      await store.threads.act({ threadIds: [thread], action: "spam", signal: null, now: NOW });
      expect(await store.replies.finish(write({ sourceStamp: stamp }))).toBe("moved");
      expect(await store.replies.finish(write({ threadId: thread + 999 }))).toBe("gone");
    });

    it("only from the state and revision it saw", async () => {
      const { store, thread, write } = await setup();
      await store.replies.finish(write());
      expect(await store.replies.transition(thread, { state: "ready", revision: 5 }, "used")).toBeNull();
      expect(await store.replies.transition(thread, { state: "used", revision: 0 }, "ready")).toBeNull();
      const used = await store.replies.transition(thread, { state: "ready", revision: 0 }, "used");
      expect(used).toMatchObject({ state: "used", revision: 1 });
      expect(await store.replies.transition(thread, { state: "ready", revision: 0 }, "used")).toBeNull();
      expect(await store.replies.transition(thread, { state: "used", revision: 1 }, "ready")).toMatchObject({ state: "ready", revision: 2 });
    });

    it("a clear empties it and refuses what began before it; the thread's going takes its row", async () => {
      const { store, thread, write } = await setup();
      await store.replies.finish(write());
      const late = write();
      await store.replies.clear();
      expect(await store.replies.get(thread)).toBeNull();
      expect(await store.replies.finish(late)).toBe("cleared");
      await store.replies.finish(write());
      const accounts = await store.accounts.list();
      await store.accounts.remove(accounts[0]!.id);
      expect(await store.replies.get(thread)).toBeNull();
    });

    it("the bounds never undo a decision: words go first", () => {
      const rows = Array.from({ length: REPLY_BODIES_MAX + 3 }, (_, i) => ({ threadId: i + 1, state: (i % 2 ? "ready" : "dismissed") as "ready" | "dismissed", hasBody: true, generatedAt: 1000 - i }));
      const { drop, forgetBody } = replyEvictions(rows);
      expect(drop).toEqual(rows.slice(REPLY_BODIES_MAX).filter((r) => r.state === "ready").map((r) => r.threadId));
      expect(forgetBody).toEqual(rows.slice(REPLY_BODIES_MAX).filter((r) => r.state === "dismissed").map((r) => r.threadId));
      const decisions = Array.from({ length: REPLY_DECISIONS_MAX + 2 }, (_, i) => ({ threadId: i + 1, state: "skipped" as const, hasBody: false, generatedAt: 10_000 - i }));
      expect(replyEvictions(decisions).drop).toEqual([REPLY_DECISIONS_MAX + 1, REPLY_DECISIONS_MAX + 2]);
    });
  });
}
