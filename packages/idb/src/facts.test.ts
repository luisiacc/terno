import "fake-indexeddb/auto";
/**
 * Plan 17 on IndexedDB, what only this adapter has to bound (Codex review 2):
 * the queue's first slice before anything listed, a sender job's walk, and
 * one very long conversation, each a bounded amount of work a slice.
 */
import type { IncomingMessage, Platform } from "@terno/store";
import { describe, expect, it, vi } from "vitest";
import { BIG_THREAD, FactsQueue, type RecencyOrder } from "./facts";
import { createMemDb } from "./schema";
import { IdbMailStore } from "./store";

const NOW = Date.UTC(2026, 9, 22, 15, 30);
const platform: Pick<Platform, "uuid" | "yield"> = { uuid: () => crypto.randomUUID(), yield: () => new Promise((r) => setTimeout(r, 0)) };

function message(accountId: number, i: number, over: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    accountId,
    providerMsgId: `m${i}`,
    providerThreadId: null,
    rfcMessageId: `m${i}@x`,
    inReplyTo: null,
    references: [],
    from: { name: "", email: "carlos@acme.com" },
    to: [{ name: "", email: "me@example.com" }],
    cc: [],
    bcc: [],
    subject: `S ${i}`,
    date: NOW - i * 1000,
    snippet: "",
    bodyText: "x",
    bodyHtml: null,
    bodyState: "full",
    listId: null,
    isRead: false,
    isStarred: false,
    inInbox: true,
    isSent: false,
    isDraft: false,
    isTrash: false,
    isSpam: false,
    hasAttachments: false,
    size: 10,
    ...over,
  };
}

describe("the facts backfill's bounds on IndexedDB (Codex review 2)", () => {
  it("before anything listed, the queue walks ids: it never asks for the recency order (a sort of every thread) (#1)", () => {
    const db = createMemDb();
    db.tx(() => {
      db.table("accounts").insert({ id: 1 });
      for (let id = 1; id <= 6000; id++) db.table("threads").insert({ id, account_id: 1, last_date: id, person: null, waiting_since: null });
    });
    const queue = new FactsQueue(db);
    const current = vi.fn(() => {
      throw new Error("sorted every thread");
    });
    const recency: RecencyOrder = { ready: false, current, after: () => 0 };
    const first = queue.next(50, recency);
    expect(first).toEqual(Array.from({ length: 50 }, (_, i) => 6000 - i));
    expect(queue.next(50, recency)[0]).toBe(5950);
    expect(current).not.toHaveBeenCalled();
  });

  it("a sender job reads its next messages through the index, never the sender's whole history a slice (#2)", async () => {
    const store = await IdbMailStore.open({ name: `facts-sender-${Date.now()}`, factory: indexedDB, platform, instantSearch: false });
    const { account } = await store.accounts.create({ kind: "imap", email: "me@example.com", displayName: "Me", color: "indigo", now: 0 });
    await store.sync.ingest(Array.from({ length: 600 }, (_, i) => message(account.id, i, { from: { name: "", email: "support@shop.com" } })), { applyFilters: false, now: NOW, classifier: null });
    await store.sync.ingest([message(account.id, 9999, { from: { name: "", email: "me@example.com" }, to: [{ name: "", email: "support@shop.com" }], isSent: true, inInbox: false })], { applyFilters: false, now: NOW, classifier: null });
    expect(await store.facts.idle()).toBe(false);
    const messages = (store as unknown as { db: { table(n: string): { by(...a: unknown[]): unknown[] } } }).db.table("messages");
    const by = vi.spyOn(messages, "by");
    let slices = 0;
    for (;;) {
      const r = await store.facts.backfill({ limit: 50 });
      slices++;
      expect(r.processed).toBeLessThanOrEqual(50);
      if (!r.more) break;
    }
    expect(slices).toBeGreaterThanOrEqual(12);
    expect(by.mock.calls.filter(([index]) => index === "from")).toEqual([]);
    expect((await store.debug.snapshot()).threads.filter((t) => t.person === true).length).toBe(600);
    await store.close();
  });

  it(`a conversation longer than ${BIG_THREAD} messages is read in chunks, one a slice, to the facts of its newest 200 (#3)`, async () => {
    const store = await IdbMailStore.open({ name: `facts-big-${Date.now()}`, factory: indexedDB, platform, instantSearch: false });
    const { account } = await store.accounts.create({ kind: "imap", email: "me@example.com", displayName: "Me", color: "indigo", now: 0 });
    const n = 3 * BIG_THREAD;
    // Carlos once, then you, n times: the window holds only your mail (no one else lately)
    const thread = Array.from({ length: n + 1 }, (_, i) =>
      message(account.id, i, { providerThreadId: null, rfcMessageId: `big${i}@x`, inReplyTo: i ? `big${i - 1}@x` : null, references: i ? [`big${i - 1}@x`] : [], date: NOW - (n + 1 - i) * 1000, ...(i ? { from: { name: "", email: "me@example.com" }, to: [{ name: "", email: "carlos@acme.com" }], isSent: true, inInbox: false } : {}) }),
    );
    for (let i = 0; i < thread.length; i += 2000) await store.sync.ingest(thread.slice(i, i + 2000), { applyFilters: false, now: NOW, classifier: null });
    expect((await store.debug.snapshot()).threads.map((t) => t.person)).toEqual([false]);
    await store.debug.resetFacts();
    let slices = 0;
    for (;;) {
      const r = await store.facts.backfill({ limit: 100_000 });
      if (r.phase !== "senders") slices++;
      if (!r.more) break;
    }
    // after the senders phase: at least three chunks of the long one (it isn't read whole in one slice), and the end
    expect(slices).toBeGreaterThanOrEqual(4);
    expect((await store.debug.snapshot()).threads.map((t) => [t.person, t.waitingSince])).toEqual([[false, null]]);
    await store.close();
  });
});
