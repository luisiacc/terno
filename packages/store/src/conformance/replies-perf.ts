import { expect } from "vitest";
import { msg } from "./fixtures";
import { expectMailbox, type WorkloadMailbox } from "./perf";

/**
 * Plan 144 revision 11 at 50k+ threads, the same on both stores: what an open that goes ahead reads before anything
 * leaves, on a short conversation and a long one, as latency and as the longest the event loop waits.
 */
export async function measureReplies(o: WorkloadMailbox, budget: { p95Ms: number; waitMs: number }): Promise<void> {
  const { store, accountId } = o;
  await expectMailbox(o, {});
  const batch = Array.from({ length: 200 }, (_, i) => msg({ accountId, providerMsgId: `long-${i}`, providerThreadId: "long-thread", subject: "Long", date: o.now - (200 - i) * 60_000 }));
  await store.sync.ingest(batch, { applyFilters: false, now: o.now, classifier: null });
  // the newest message is the long conversation's, what's far behind it someone else's
  const newest = await store.filters.messageWalk().next(1000);
  const [longThread] = await store.filters.threadsOf(newest.slice(0, 1));
  const [shortThread] = await store.filters.threadsOf(newest.slice(-1));
  for (const [name, thread] of [["short", shortThread!], ["long", longThread!]] as const) {
    const times: number[] = [];
    let longest = 0;
    let beat = performance.now();
    let walking = true;
    const probe = () => {
      const at = performance.now();
      longest = Math.max(longest, at - beat);
      beat = at;
      if (walking) setTimeout(probe);
    };
    setTimeout(probe);
    for (let i = 0; i < 40; i++) {
      const started = performance.now();
      await store.threads.summaries([thread]);
      await store.drafts.list();
      await store.aiSummaries.sources(thread);
      await store.replies.get(thread);
      await store.writing.threadContext(thread, { maxBodies: 2, maxChars: 4000 });
      times.push(performance.now() - started);
      await new Promise<void>((resolve) => setTimeout(resolve));
    }
    walking = false;
    const p95 = times.sort((a, b) => a - b)[37]!;
    o.log(`replies ${name}: p95 ${p95.toFixed(1)} ms, longest wait ${longest.toFixed(1)} ms`);
    expect(p95, `${name} p95`).toBeLessThanOrEqual(budget.p95Ms * o.budget);
    expect(longest, `${name} longest wait`).toBeLessThanOrEqual(budget.waitMs * o.budget);
  }
}
