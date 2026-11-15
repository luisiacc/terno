/**
 * Plan 210 (Codex code review): the history's walk over a store's closed rows. A reload down to a line whose lines all left
 * meanwhile still continues from it; a walk past many left-out rows gives the event loop back between reads; an untrusted
 * sender's newer item, never shown, hides neither an older item nor your promise on its conversation.
 */
import type { DatedRow, FollowupRow, ThreadSummary } from "@terno/core";
import type { MailStore } from "@terno/store";
import { describe, expect, it } from "vitest";
import { historyPage, type HistoryAsk } from "./today-history";

const NOW = 100 * 86_400_000;
const MIN = 60_000;
type Closed = { id: number; threadId: number; closedAt: number; senderKey?: string };

/** a store of closed rows (newest first by closing, then id): dated items and promises; `spam` threads are in Spam */
function fakeStore(datedRows: Closed[], promiseRows: Closed[] = [], spam: ReadonlySet<number> = new Set()) {
  const dated = datedRows.map((r) => ({ state: "done", closedReason: "user", kind: "pay", text: `Pay ${r.id}`, senderKey: "billing@power.test", ...r }) as unknown as DatedRow);
  const promises = promiseRows.map((r) => ({ state: "done", closedReason: "user", kind: "promise", text: `send ${r.id}`, ...r }) as unknown as FollowupRow);
  const order = <T extends { closedAt: number | null; id: number }>(rows: T[]) => [...rows].sort((a, b) => b.closedAt! - a.closedAt! || b.id - a.id);
  const page = <T extends { closedAt: number | null; id: number }>(rows: T[]) => async (o: { since: number; after: { at: number; id: number } | null; limit: number }) => {
    reads.count++;
    return order(rows).filter((r) => r.closedAt! >= o.since && (!o.after || r.closedAt! < o.after.at || (r.closedAt === o.after.at && r.id < o.after.id))).slice(0, o.limit);
  };
  const newest = <T extends { closedAt: number | null; id: number; threadId: number }>(rows: T[]) => async (ids: readonly number[]) =>
    new Map(ids.flatMap((id) => {
      const top = order(rows.filter((r) => r.threadId === id))[0];
      return top ? [[id, { at: top.closedAt!, id: top.id }] as const] : [];
    }));
  const reads = { count: 0 };
  const store = {
    dated: { closedPage: page(dated), newestClosed: newest(dated), get: async (id: number) => dated.find((r) => r.id === id) ?? null, written: async () => new Set<string>() },
    followups: { closedPage: page(promises), newestClosed: newest(promises) },
    threads: { summaries: async (ids: readonly number[]) => ids.map((id) => ({ id, inSpam: spam.has(id), inTrash: false }) as ThreadSummary) },
  } as unknown as MailStore;
  return { store, reads };
}
const bills = (n: number): Closed[] => Array.from({ length: n }, (_, i) => ({ id: i + 1, threadId: i + 1, closedAt: NOW - (i + 1) * MIN }));

const ask = (over: Partial<HistoryAsk>): HistoryAsk => ({ now: NOW, after: null, through: null, limit: 40, exclude: new Set(), dated: true, promises: true, yieldTurn: async () => {}, sliceMs: 1000, ...over });

describe("historyPage", () => {
  it("a reload down to a line whose lines all left meanwhile continues from that line, never ending the history", async () => {
    const { store } = fakeStore(bills(10), [], new Set([1, 2, 3]));
    const through = { at: NOW - 3 * MIN, src: 0 as const, id: 3 };
    const page = await historyPage(store, ask({ through }));
    expect(page.items).toEqual([]);
    expect(page.next).toEqual(through);
    const after = await historyPage(store, ask({ after: page.next, limit: 3 }));
    expect(after.items.map((i) => i.thread.id)).toEqual([4, 5, 6]);
  });

  it("past many left-out rows (Spam), it gives the event loop back between reads", async () => {
    const { store, reads } = fakeStore(bills(450), [], new Set(Array.from({ length: 449 }, (_, i) => i + 1)));
    let yields = 0;
    const page = await historyPage(store, ask({ sliceMs: 0, yieldTurn: async () => void yields++ }));
    expect(page.items.map((i) => i.thread.id)).toEqual([450]);
    expect(reads.count).toBeGreaterThanOrEqual(5);
    expect(yields).toBeGreaterThanOrEqual(reads.count - 1);
  });

  it("an untrusted sender's newer item hides neither the conversation's older item nor your promise, from the top or past a key", async () => {
    // conversation 7: an untrusted item (never shown) newest, then your promise, then a trusted item; conversation 1 newer still
    const untrusted = "alerts@bank-security-alerts.com";
    const { store } = fakeStore(
      [{ id: 1, threadId: 1, closedAt: NOW - MIN }, { id: 70, threadId: 7, closedAt: NOW - 2 * MIN, senderKey: untrusted }, { id: 71, threadId: 7, closedAt: NOW - 5 * MIN }],
      [{ id: 9, threadId: 7, closedAt: NOW - 3 * MIN }],
    );
    const top = await historyPage(store, ask({}));
    expect(top.items.map((i) => [i.thread.id, i.kind])).toEqual([[1, "pay"], [7, "promise"]]);
    const after = await historyPage(store, ask({ after: top.items[0]!.key }));
    expect(after.items.map((i) => [i.thread.id, i.kind])).toEqual([[7, "promise"]]);
    // past the promise's own key, the conversation's line was above: its older item isn't a second one
    expect((await historyPage(store, ask({ after: top.items[1]!.key }))).items).toEqual([]);
  });
});
