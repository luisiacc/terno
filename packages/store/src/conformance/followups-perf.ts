import { expect } from "vitest";
import { AWAITING_ITEM, FOLLOWUPS_ACTIVE_MAX, type FollowupWrite } from "../followups";
import { msg } from "./fixtures";
import { expectMailbox, type WorkloadMailbox } from "./perf";

/**
 * Plan 142 at 50k+ threads, the same workload on both stores, at the cap of 1,000 active rows: the list, the one timer's
 * probe, what opening a thread reads, and closing replies over all of them in chunks.
 */
export async function measureFollowups(o: WorkloadMailbox): Promise<void> {
  const { store, accountId } = o;
  await expectMailbox(o, {});
  const seed = performance.now();
  const me = { name: "Me", email: "me@perf.test" };
  const tom = { name: "Tom", email: "tom@perf.test" };
  const ids: { id: number; thread: number }[] = [];
  for (let slice = 0; slice < 10; slice++) {
    const batch = Array.from({ length: 100 }, (_, i) => msg({ accountId, from: me, to: [tom], isSent: true, inInbox: false, providerMsgId: `fu-${slice}-${i}`, subject: `Fu ${slice}-${i}`, date: o.now - 1000 - i, bodyText: "x" }));
    const r = await store.sync.ingest(batch, { applyFilters: false, now: o.now, classifier: null, liveSent: { wanted: true } });
    for (const id of r.inserted) ids.push({ id, thread: (await store.followups.source(id))!.threadId });
  }
  const row = (i: number): FollowupWrite => (i % 2 ? { kind: "promise", item: 0, text: "send it", quote: "I'll send it", personName: "Tom", personEmail: tom.email, dueAt: o.now + 86_400_000 + i, dated: false } : { kind: "awaiting", item: AWAITING_ITEM, text: "", quote: null, personName: "Tom", personEmail: tom.email, dueAt: o.now + 86_400_000 + i, dated: false });
  let n = 0;
  for (const { id, thread } of ids.slice(0, FOLLOWUPS_ACTIVE_MAX)) await store.followups.finish({ messageId: id, threadId: thread, fromScan: false, rows: [row(n++)], kept: [], now: o.now, model: "m", provider: "p", promptVersion: 1, clearGeneration: store.followups.clearGeneration() });
  o.log(`1,000 follow-ups written in ${(performance.now() - seed).toFixed(0)} ms`);
  const active = await store.followups.active();
  expect(active).toHaveLength(FOLLOWUPS_ACTIVE_MAX);
  const timed = async (runs: number, work: (i: number) => Promise<unknown>) => {
    const times: number[] = [];
    for (let i = 0; i < runs; i++) {
      const start = performance.now();
      await work(i);
      times.push(performance.now() - start);
    }
    return [...times].sort((a, b) => a - b)[Math.ceil(runs * 0.95) - 1]!;
  };
  const list = await timed(10, () => store.followups.active());
  const probe = await timed(20, () => store.followups.nextDue());
  const thread = await timed(20, (i) => store.followups.ofThread(ids[i]!.thread));
  const waits = active.filter((r) => r.kind === "awaiting").map((r) => r.id);
  const chunk = await timed(5, (i) => store.followups.closeAnswered(waits.slice(i * 50, i * 50 + 50), o.now));
  const off = await timed(5, () => store.sync.ingest([], { applyFilters: false, now: o.now, classifier: null }));
  o.log(`Follow-ups: the active list ${list.toFixed(2)} ms, the timer's probe ${probe.toFixed(2)} ms, a thread's ${thread.toFixed(2)} ms, 50 replies' check ${chunk.toFixed(2)} ms, an empty ingest ${off.toFixed(2)} ms`);
  expect(list).toBeLessThanOrEqual(5 * o.budget * 3);
  expect(probe).toBeLessThanOrEqual(5 * o.budget);
  expect(thread).toBeLessThanOrEqual(5 * o.budget);
  expect(chunk).toBeLessThanOrEqual(16 * o.budget);
}
