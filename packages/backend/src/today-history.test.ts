/**
 * Plan 210 (Codex code review): the history's walk over a store's closed rows. A reload down to a line whose lines all left
 * meanwhile still continues from it; a walk past many left-out rows gives the event loop back between reads. Iteration 2: a
 * line per closed item (two of one conversation are two lines), an untrusted sender's never; true duplicates one line at
 * their newest closing, none while one of them is open, once across pages; a held row none.
 */
import type { DatedRow, FollowupRow, ThreadSummary } from "@terno/core";
import type { MailStore } from "@terno/store";
import { describe, expect, it } from "vitest";
import { historyPage, type HistoryAsk } from "./today-history";

const NOW = 100 * 86_400_000;
const MIN = 60_000;
type Closed = { id: number; threadId: number; closedAt: number | null; senderKey?: string; sameAs?: string | null; state?: string; closedReason?: string; settledAt?: number };

/** a store of closed rows (newest first by closing, then id): dated items and promises; `spam` threads are in Spam */
function fakeStore(datedRows: Closed[], promiseRows: Closed[] = [], spam: ReadonlySet<number> = new Set()) {
  const dated = datedRows.map((r) => ({ state: "done", closedReason: "user", kind: "pay", text: `Pay ${r.id}`, senderKey: "billing@power.test", sameAs: null, ...r }) as unknown as DatedRow);
  const promises = promiseRows.map((r) => ({ state: "done", closedReason: "user", kind: "promise", text: `send ${r.id}`, sameAs: null, ...r }) as unknown as FollowupRow);
  const order = <T extends { closedAt: number | null; id: number }>(rows: T[]) => [...rows].sort((a, b) => b.closedAt! - a.closedAt! || b.id - a.id);
  const page = <T extends { closedAt: number | null; id: number; state: string }>(rows: T[]) => async (o: { since: number; after: { at: number; id: number } | null; limit: number }) => {
    reads.count++;
    return order(rows.filter((r) => r.state !== "open" && r.state !== "due")).filter((r) => r.closedAt! >= o.since && (!o.after || r.closedAt! < o.after.at || (r.closedAt === o.after.at && r.id < o.after.id))).slice(0, o.limit);
  };
  const reads = { count: 0 };
  const members = async (keys: readonly string[]) => ({
    dated: dated.filter((r) => keys.includes(`dated:${r.id}`) || (r.sameAs != null && keys.includes(r.sameAs))),
    promises: promises.filter((r) => keys.includes(`promise:${r.id}`) || (r.sameAs != null && keys.includes(r.sameAs))),
  });
  const store = {
    dated: { closedPage: page(dated), written: async () => new Set<string>() },
    followups: { closedPage: page(promises) },
    today: { members },
    threads: { summaries: async (ids: readonly number[]) => ids.map((id) => ({ id, inSpam: spam.has(id), inTrash: false }) as ThreadSummary) },
  } as unknown as MailStore;
  return { store, reads };
}
const bills = (n: number): Closed[] => Array.from({ length: n }, (_, i) => ({ id: i + 1, threadId: i + 1, closedAt: NOW - (i + 1) * MIN }));

const ask = (over: Partial<HistoryAsk>): HistoryAsk => ({ now: NOW, after: null, through: null, limit: 40, held: new Set(), dated: true, promises: true, yieldTurn: async () => {}, sliceMs: 1000, ...over });

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

  it("a line per closed item: two of one conversation are two, an untrusted sender's none, each with its item's id", async () => {
    const untrusted = "alerts@bank-security-alerts.com";
    const { store } = fakeStore(
      [{ id: 1, threadId: 1, closedAt: NOW - MIN }, { id: 70, threadId: 7, closedAt: NOW - 2 * MIN, senderKey: untrusted }, { id: 71, threadId: 7, closedAt: NOW - 5 * MIN }],
      [{ id: 9, threadId: 7, closedAt: NOW - 3 * MIN }],
    );
    const top = await historyPage(store, ask({}));
    expect(top.items.map((i) => [i.id, i.thread.id, i.kind])).toEqual([["dated:1", 1, "pay"], ["promise:9", 7, "promise"], ["dated:71", 7, "pay"]]);
    expect(top.items[2]!.item).toEqual({ source: "dated", id: 71 });
    const after = await historyPage(store, ask({ after: top.items[1]!.key }));
    expect(after.items.map((i) => i.id)).toEqual(["dated:71"]);
    // a held row has none
    expect((await historyPage(store, ask({ held: new Set(["promise:9"]) }))).items.map((i) => i.id)).toEqual(["dated:1", "dated:71"]);
  });

  it("plan 210 (iteration 3, revision 4): a promise its person replaced says so, apart from Done and Remove", async () => {
    const { store } = fakeStore([], [{ id: 3, threadId: 3, closedAt: NOW - MIN, state: "dismissed", closedReason: "replaced" }, { id: 4, threadId: 4, closedAt: NOW - 2 * MIN, state: "dismissed" }, { id: 5, threadId: 5, closedAt: NOW - 3 * MIN }]);
    expect((await historyPage(store, ask({}))).items.map((i) => [i.id, i.outcome])).toEqual([["promise:3", "replaced"], ["promise:4", "dismissed"], ["promise:5", "done"]]);
  });

  it("plan 210 (iteration 4, revision 7): settled by mail, a line says that mail's day and how, while its place stays the closing's", async () => {
    // Monday's receipt read on Wednesday; a request your reply answered on Tuesday, read later; one Done by hand
    const { store } = fakeStore(
      [
        { id: 1, threadId: 1, closedAt: NOW - MIN, state: "settled", closedReason: "settled", settledAt: NOW - 2 * 86_400_000 },
        { id: 2, threadId: 2, closedAt: NOW - 2 * MIN, state: "settled", closedReason: "answered", settledAt: NOW - 86_400_000 },
        { id: 3, threadId: 3, closedAt: NOW - 3 * MIN },
      ],
    );
    const { items } = await historyPage(store, ask({}));
    expect(items.map((i) => [i.id, i.key.at, i.outcome, i.on, i.reason])).toEqual([
      ["dated:1", NOW - MIN, "settled", NOW - 2 * 86_400_000, "settled"],
      ["dated:2", NOW - 2 * MIN, "settled", NOW - 86_400_000, "answered"],
      ["dated:3", NOW - 3 * MIN, "done", undefined, "user"],
    ]);
  });

  it("true duplicates: one line at their newest closing, whichever table; none while one is open; once across pages", async () => {
    // a bill and your promise of it (canonical dated:20), the promise closed last; a dinner read twice, one still open
    const { store } = fakeStore(
      [{ id: 20, threadId: 2, closedAt: NOW - 4 * MIN }, { id: 30, threadId: 3, closedAt: NOW - 2 * MIN }, { id: 31, threadId: 4, closedAt: null, state: "open", sameAs: "dated:30" }, { id: 40, threadId: 5, closedAt: NOW - 6 * MIN }],
      [{ id: 21, threadId: 2, closedAt: NOW - MIN, sameAs: "dated:20" }],
    );
    const top = await historyPage(store, ask({}));
    expect(top.items.map((i) => [i.id, i.item, i.kind])).toEqual([
      ["dated:20", { source: "promise", id: 21 }, "promise"],
      ["dated:40", { source: "dated", id: 40 }, "pay"],
    ]);
    // a page from the merged line's key: the bill's own older closing isn't a second line
    expect((await historyPage(store, ask({ after: top.items[0]!.key }))).items.map((i) => i.id)).toEqual(["dated:40"]);
    expect((await historyPage(store, ask({ limit: 1 }))).items.map((i) => i.id)).toEqual(["dated:20"]);
  });

  it("Codex code review: a merged item's newest closing in Spam never hides the line: its newest closing that may show is", async () => {
    const { store } = fakeStore([{ id: 50, threadId: 5, closedAt: NOW - 3 * MIN }, { id: 51, threadId: 6, closedAt: NOW - MIN, sameAs: "dated:50" }], [], new Set([6]));
    const top = await historyPage(store, ask({}));
    expect(top.items.map((i) => [i.id, i.item, i.thread.id])).toEqual([["dated:50", { source: "dated", id: 50 }, 5]]);
  });
});
