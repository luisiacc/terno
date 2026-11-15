/**
 * Plan 210 (Codex code review): the history's walk over a store's closed rows. A reload down to a line whose lines all left
 * meanwhile still continues from it; a walk past many left-out rows gives the event loop back between reads.
 */
import type { DatedRow, ThreadSummary } from "@terno/core";
import type { MailStore } from "@terno/store";
import { describe, expect, it } from "vitest";
import { historyPage, type HistoryAsk } from "./today-history";

const NOW = 100 * 86_400_000;

/** closed items, thread id = item id, closed a minute apart, newest first; `spam` threads are in Spam */
function fakeStore(n: number, spam: ReadonlySet<number> = new Set()) {
  const rows = Array.from({ length: n }, (_, i) => ({ id: i + 1, threadId: i + 1, closedAt: NOW - (i + 1) * 60_000, state: "done", closedReason: "user", kind: "pay", text: `Pay ${i + 1}`, senderKey: "a@b.test" }) as unknown as DatedRow);
  const reads = { count: 0 };
  const store = {
    dated: {
      closedPage: async (o: { since: number; after: { at: number; id: number } | null; limit: number }) => {
        reads.count++;
        return rows.filter((r) => r.closedAt! >= o.since && (!o.after || r.closedAt! < o.after.at || (r.closedAt === o.after.at && r.id < o.after.id))).slice(0, o.limit);
      },
      newestClosed: async (ids: readonly number[]) => new Map(ids.map((id) => [id, { at: rows[id - 1]!.closedAt!, id }])),
      written: async () => new Set<string>(),
    },
    followups: { closedPage: async () => [], newestClosed: async () => new Map() },
    threads: { summaries: async (ids: readonly number[]) => ids.map((id) => ({ id, inSpam: spam.has(id), inTrash: false }) as ThreadSummary) },
  } as unknown as MailStore;
  return { store, rows, reads };
}

const ask = (over: Partial<HistoryAsk>): HistoryAsk => ({ now: NOW, after: null, through: null, limit: 40, exclude: new Set(), dated: true, promises: false, yieldTurn: async () => {}, sliceMs: 1000, ...over });

describe("historyPage", () => {
  it("a reload down to a line whose lines all left meanwhile continues from that line, never ending the history", async () => {
    const { store } = fakeStore(10, new Set([1, 2, 3]));
    const through = { at: NOW - 3 * 60_000, src: 0 as const, id: 3 };
    const page = await historyPage(store, ask({ through }));
    expect(page.items).toEqual([]);
    expect(page.next).toEqual(through);
    const after = await historyPage(store, ask({ after: page.next, limit: 3 }));
    expect(after.items.map((i) => i.thread.id)).toEqual([4, 5, 6]);
  });

  it("past many left-out rows (Spam), it gives the event loop back between reads", async () => {
    const { store, reads } = fakeStore(450, new Set(Array.from({ length: 449 }, (_, i) => i + 1)));
    let yields = 0;
    const page = await historyPage(store, ask({ sliceMs: 0, yieldTurn: async () => void yields++ }));
    expect(page.items.map((i) => i.thread.id)).toEqual([450]);
    expect(reads.count).toBeGreaterThanOrEqual(5);
    expect(yields).toBeGreaterThanOrEqual(reads.count - 1);
  });
});
