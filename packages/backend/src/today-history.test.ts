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
type Closed = { id: number; threadId: number; closedAt: number | null; senderKey?: string; sameAs?: string | null; state?: string; closedReason?: string; settledAt?: number; settledBy?: number; answers?: number };

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
    dated: { closedPage: page(dated), written: async () => new Set<string>(), ofThread: async (id: number) => dated.filter((r) => r.threadId === id && r.state === "open") },
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

  it("plan 210 (iteration 4): an item handed on by a confirmed forward says to whom, apart from Done; a request it settled has no line", async () => {
    const jess = { name: "Jess Okafor", email: "jess@home.test" };
    const { store } = fakeStore(
      [{ id: 1, threadId: 1, closedAt: NOW - MIN, closedReason: "handed", handedTo: jess } as Closed, { id: 2, threadId: 2, closedAt: NOW - 2 * MIN, state: "settled", closedReason: "promise" }, { id: 3, threadId: 3, closedAt: NOW - 3 * MIN }],
      [{ id: 4, threadId: 4, closedAt: NOW - 4 * MIN, closedReason: "handed", handedTo: jess } as Closed],
    );
    const items = (await historyPage(store, ask({}))).items;
    expect(items.map((i) => [i.id, i.outcome, i.handedTo?.email])).toEqual([["dated:1", "handed", jess.email], ["dated:3", "done", undefined], ["promise:4", "handed", jess.email]]);
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

  it("the claims ledger's third batch: one delivery that answered a request and kept the promise to it is one line, the request's", async () => {
    // Theo's script: Jess's request (dated:1) and his promise to send it (promise:1), both closed by his mail (message 75)
    const sent = { state: "settled", closedReason: "answered", settledBy: 75, settledAt: NOW - 2 * MIN };
    const { store } = fakeStore(
      [{ id: 1, threadId: 2, closedAt: NOW - MIN, ...sent }, { id: 3, threadId: 4, closedAt: NOW - 3 * MIN, ...sent, settledBy: 80 }],
      [
        { id: 1, threadId: 2, closedAt: NOW - MIN, closedReason: "kept", settledBy: 75, answers: 1 },
        // a request settled by another mail than the one that kept the promise: two things, two lines
        { id: 3, threadId: 4, closedAt: NOW - 3 * MIN, closedReason: "kept", settledBy: 81, answers: 3 },
        // a promise kept while the request it answers is still open: its own line
        { id: 5, threadId: 6, closedAt: NOW - 4 * MIN, closedReason: "kept", settledBy: 90, answers: 9 },
      ],
    );
    const { items } = await historyPage(store, ask({}));
    expect(items.map((i) => [i.id, i.outcome, i.reason])).toEqual([["dated:1", "settled", "answered"], ["dated:3", "settled", "answered"], ["promise:3", "done", "kept"], ["promise:5", "done", "kept"]]);
  });

  it("the claims ledger's third batch: a plan that's over says its own day, a deadline over still its closing", async () => {
    // Friday's furnace tune-up retired by Saturday morning's sweep; a bill that left Missed the same morning
    const friday = NOW - 86_400_000 + 12 * 60 * MIN;
    const { store } = fakeStore([
      { id: 13, threadId: 1, closedAt: NOW - MIN, state: "dismissed", closedReason: "expired", kind: "event", dueAt: friday } as Closed,
      { id: 14, threadId: 2, closedAt: NOW - 2 * MIN, state: "dismissed", closedReason: "expired", dueAt: friday - 8 * 86_400_000 } as Closed,
    ]);
    const { items } = await historyPage(store, ask({}));
    expect(items.map((i) => [i.id, i.outcome, i.key.at, i.on])).toEqual([["dated:13", "over", NOW - MIN, friday], ["dated:14", "over", NOW - 2 * MIN, undefined]]);
  });

  it("the claims ledger's third batch: an ask asked again with a day has no line; the request it became has its own", async () => {
    // Jordan's Owen: the undated ask (dated:10) closed by his follow-up, which made the request with a day (dated:21)
    const { store } = fakeStore([
      { id: 21, threadId: 19, closedAt: NOW - MIN, state: "settled", closedReason: "answered", settledBy: 75 },
      { id: 10, threadId: 19, closedAt: NOW - 2 * MIN, state: "settled", closedReason: "reasked", settledBy: 64 },
    ]);
    expect((await historyPage(store, ask({}))).items.map((i) => [i.id, i.reason])).toEqual([["dated:21", "answered"]]);
  });

  it("the claims ledger's third batch: a parcel's notice over by its day while a newer notice of it is on its way has no line", async () => {
    // Diego's arm: the first notice (Nov 12–13, stored on the 12th) went over; the next notice of the same arm, moved to
    // Tuesday, is open. Another parcel over in another conversation keeps its line, and so does one with no newer notice
    const arm = { kind: "delivery", state: "dismissed", closedReason: "expired" };
    const { store } = fakeStore([
      { id: 12, threadId: 20, closedAt: NOW - MIN, ...arm, text: "Llega el brazo articulado doble para monitor", arrivedAt: NOW - 5 * 86_400_000 } as Closed,
      { id: 28, threadId: 20, closedAt: null, state: "open", kind: "delivery", text: "Llega el brazo articulado doble para monitor, 9–14 h", arrivedAt: NOW - 4 * 86_400_000 } as Closed,
      { id: 13, threadId: 21, closedAt: NOW - 2 * MIN, ...arm, text: "Llega la lámpara de escritorio", arrivedAt: NOW - 5 * 86_400_000 } as Closed,
      { id: 29, threadId: 21, closedAt: null, state: "open", kind: "delivery", text: "Llegan las pilas recargables", arrivedAt: NOW - 4 * 86_400_000 } as Closed,
    ]);
    expect((await historyPage(store, ask({}))).items.map((i) => i.id)).toEqual(["dated:13"]);
  });
});
