import type { ArrivalRow, ThreadSummary } from "@terno/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_WAITS_MAX, AgentMailWaits, AgentWaitBusyError, type AgentWaitMatch } from "./agent-mail-waits";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const thread = (id: number, o: Partial<ThreadSummary> = {}): ThreadSummary => ({
  id, accountId: 1, subject: `t${id}`, snippet: "", lastDate: Date.now(), fromName: "A", fromEmail: "a@example.com", messageCount: 1,
  unread: true, starred: false, hasAttachments: false, categoryIds: [], inInbox: true, inSpam: false, inTrash: false, ...o,
});

function rig(o: { bodyFilters?: boolean | (() => Promise<boolean>); onLog?: () => void } = {}) {
  const rows = new Map<number, ArrivalRow>();
  const threads = new Map<number, ThreadSummary>();
  const watches = new Map<string, number>();
  const reads = { arrivals: [] as number[][], summaries: 0 };
  let gate: Promise<void> | null = null;
  let fail = 0;
  const waits = new AgentMailWaits({
    watch: (key, accountId) => void watches.set(key, accountId),
    unwatch: (key) => void watches.delete(key),
    arrivals: async (ids) => {
      reads.arrivals.push([...ids]);
      if (gate) await gate;
      if (fail > 0 && fail--) throw new Error("store busy");
      return ids.map((id) => rows.get(id)).filter((r): r is ArrivalRow => !!r);
    },
    summaries: async (ids) => {
      reads.summaries++;
      return ids.map((id) => threads.get(id)).filter((t): t is ThreadSummary => !!t);
    },
    bodyFilters: async () => (typeof o.bodyFilters === "function" ? o.bodyFilters() : (o.bodyFilters ?? false)),
    log: () => o.onLog?.(),
    yieldTurn: async () => {},
    now: () => Date.now(),
  });
  /** message `id` in thread `threadId`, just inserted */
  const message = (id: number, threadId: number, m: Partial<ArrivalRow> = {}, t: Partial<ThreadSummary> = {}) => {
    rows.set(id, { id, threadId, accountId: 1, date: Date.now(), fromName: "Ana", fromEmail: "ana@example.com", subject: "Hello", snippet: "", isRead: false, isSent: false, isDraft: false, inInbox: true, isTrash: false, isSpam: false, bodyPending: false, ...m } as ArrivalRow);
    threads.set(threadId, thread(threadId, t));
  };
  const wait = (match?: AgentWaitMatch, o2: { clientId?: string; quick?: boolean } = {}) => waits.wait({ clientId: o2.clientId ?? "c", accountId: 1, match, waitMs: 30_000, quick: o2.quick ?? true });
  return { waits, message, watches, reads, wait, gate: (g: Promise<void> | null) => void (gate = g), failNext: () => void (fail = 1) };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

describe("AgentMailWaits (plan 191)", () => {
  it("new mail on the account ends the wait with its conversation, and the watch and the timer go", async () => {
    const r = rig();
    const wait = r.wait();
    expect([...r.watches.values()]).toEqual([1]);
    await vi.advanceTimersByTimeAsync(4_000);
    r.message(10, 100);
    r.waits.arrived(1, [10]);
    expect(await wait).toEqual({ items: [{ threadId: 100, messageId: 10, fromName: "Ana", fromEmail: "ana@example.com", subject: "Hello", snippet: "", date: expect.any(Number) }], waitedMs: 4_000 });
    expect(r.watches.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a push or poll-only account isn't watched (no checks), only listened to", async () => {
    const r = rig();
    const wait = r.wait(undefined, { quick: false });
    expect(r.watches.size).toBe(0);
    r.message(10, 100);
    r.waits.arrived(1, [10]);
    expect((await wait).items).toHaveLength(1);
  });

  it("mail in Spam or Trash (the message or its conversation), sent, a draft or another account's doesn't end it; the deadline does, with nothing", async () => {
    const r = rig();
    const wait = r.wait();
    r.message(1, 101, { isSpam: true });
    r.message(2, 102, { isTrash: true });
    r.message(3, 103, { isSent: true });
    r.message(4, 104, { isDraft: true });
    r.message(5, 105, { accountId: 2 });
    r.message(6, 106, {}, { inSpam: true });
    r.message(7, 107, {}, { inTrash: true });
    r.waits.arrived(1, [1, 2, 3, 4, 5, 6, 7]);
    r.waits.arrived(2, [5]);
    await flush();
    expect(r.waits.size).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await wait).toEqual({ items: [], waitedMs: 30_000 });
    expect(r.watches.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("matches the new message itself: its sender (address or name) and its subject, any case", async () => {
    const r = rig();
    const wait = r.wait({ from: "GitHub.com", subject: " code " });
    r.message(1, 200, { fromEmail: "noreply@github.com", subject: "Your newsletter" });
    r.message(2, 201, { fromEmail: "ana@example.com", subject: "Your code" });
    r.waits.arrived(1, [1, 2]);
    await flush();
    expect(r.waits.size).toBe(1);
    r.message(3, 202, { fromEmail: "noreply@github.com", subject: "[GitHub] Your CODE is 1234" });
    r.waits.arrived(1, [3]);
    expect((await wait).items.map((t) => t.threadId)).toEqual([202]);
    const byName = r.wait({ from: "acme bank" });
    r.message(4, 203, { fromName: "ACME Bank", fromEmail: "x@mailer.test" });
    r.waits.arrived(1, [4]);
    expect((await byName).items.map((t) => t.threadId)).toEqual([203]);
  });

  it("while a filter reads bodies, a match whose body hasn't come waits for it", async () => {
    const r = rig({ bodyFilters: true });
    const wait = r.wait();
    r.message(1, 100, { bodyPending: true });
    r.waits.arrived(1, [1]);
    await flush();
    expect(r.waits.size).toBe(1);
    // the body came, and the filter moved it to Spam: still nothing
    r.message(1, 100, { isSpam: true });
    r.waits.bodyArrived(1);
    await flush();
    expect(r.waits.size).toBe(1);
    r.message(2, 101, { bodyPending: true });
    r.waits.arrived(1, [2]);
    await flush();
    r.message(2, 101, { bodyPending: false });
    r.waits.bodyArrived(2);
    expect((await wait).items.map((t) => t.threadId)).toEqual([101]);
  });

  it("a body that comes while the wait asks about filters isn't missed (Codex code review #2)", async () => {
    let answer!: (v: boolean) => void;
    const r = rig({ bodyFilters: () => new Promise<boolean>((resolve) => (answer = resolve)) });
    const wait = r.wait();
    r.message(1, 100, { bodyPending: true });
    r.waits.arrived(1, [1]);
    await flush();
    // the filters are being asked about: the body comes now, then the answer (a filter reads bodies)
    r.message(1, 100, { bodyPending: false });
    r.waits.bodyArrived(1);
    answer(true);
    expect((await wait).items.map((t) => t.threadId)).toEqual([100]);
  });

  it("an arrival queued as a look ends is looked at, not left for the next one (Codex code review #3)", async () => {
    let r!: ReturnType<typeof rig>;
    // the look fails; while it winds down (its failure logged) a new message comes
    r = rig({ onLog: () => { r.message(2, 200); r.waits.arrived(1, [2]); } });
    const wait = r.wait();
    r.failNext();
    r.message(1, 100);
    r.waits.arrived(1, [1]);
    expect((await wait).items.map((t) => t.threadId)).toEqual([200]);
  });

  it("an agent's new wait on the account ends its last one (a call it cancelled leaves nothing running)", async () => {
    const r = rig();
    const first = r.wait(undefined, { clientId: "a" });
    const other = r.wait(undefined, { clientId: "b" });
    const second = r.wait(undefined, { clientId: "a" });
    expect((await first).items).toEqual([]);
    expect(r.waits.size).toBe(2);
    expect(r.watches.size).toBe(2);
    r.message(1, 100);
    r.waits.arrived(1, [1]);
    expect((await second).items).toHaveLength(1);
    expect((await other).items).toHaveLength(1);
  });

  it("listens only while a wait is on the account (a pass collects nothing otherwise)", async () => {
    const r = rig();
    expect(r.waits.listening(1)).toBe(false);
    const wait = r.wait();
    expect(r.waits.listening(1)).toBe(true);
    expect(r.waits.listening(2)).toBe(false);
    await r.waits.stop();
    await wait;
    expect(r.waits.listening(1)).toBe(false);
  });

  it("with no wait, an arrival reads nothing", async () => {
    const r = rig();
    r.message(1, 100);
    r.waits.arrived(1, [1]);
    r.waits.bodyArrived(1);
    await flush();
    expect(r.reads).toEqual({ arrivals: [], summaries: 0 });
  });

  it("one look at a time, in bounded reads; arrivals meanwhile go in the same look", async () => {
    const r = rig();
    let open!: () => void;
    r.gate(new Promise<void>((resolve) => (open = resolve)));
    const wait = r.wait({ subject: "never" });
    r.waits.arrived(1, Array.from({ length: 450 }, (_, i) => i + 1));
    r.waits.arrived(1, [1000]);
    await flush();
    expect(r.reads.arrivals).toHaveLength(1);
    r.gate(null);
    open();
    await flush();
    expect(r.reads.arrivals.map((ids) => ids.length)).toEqual([200, 200, 51]);
    r.waits.stop();
    await wait;
  });

  it("the agent going, or stop, ends its waits with nothing; stop waits for a look reading the store", async () => {
    const r = rig();
    const a = r.wait(undefined, { clientId: "a" });
    const b = r.wait(undefined, { clientId: "b" });
    r.waits.disconnected("a");
    expect((await a).items).toEqual([]);
    expect(r.waits.size).toBe(1);
    let open!: () => void;
    r.gate(new Promise<void>((resolve) => (open = resolve)));
    r.message(1, 100);
    r.waits.arrived(1, [1]);
    let stopped = false;
    const stopping = r.waits.stop().then(() => void (stopped = true));
    expect((await b).items).toEqual([]);
    await flush();
    expect(stopped).toBe(false);
    open();
    await stopping;
    // the look saw its wait was over: it read nothing more
    expect(r.reads.summaries).toBe(0);
    expect(r.watches.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect((await r.wait()).items).toEqual([]);
  });

  it(`at most ${AGENT_WAITS_MAX} waits at once`, async () => {
    const r = rig();
    const waits = Array.from({ length: AGENT_WAITS_MAX }, (_, i) => r.wait(undefined, { clientId: `c${i}` }));
    await expect(r.wait()).rejects.toBeInstanceOf(AgentWaitBusyError);
    await r.waits.stop();
    await Promise.all(waits);
  });
});
