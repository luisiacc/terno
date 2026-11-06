import { expect } from "vitest";
import { expectMailbox, type WorkloadMailbox } from "./perf";

/**
 * Plan 145 at 50k+ threads, the same on both stores: Today's waiting walk, and the digest's walk by arrival among
 * recent automated mail, sparse and empty, in pages with a turn between them (revision 11).
 */
export async function measureToday(o: WorkloadMailbox, budget: { waitingMs: number; pageMs: number }): Promise<void> {
  const { store } = o;
  await expectMailbox(o, {});
  const times: number[] = [];
  for (let i = 0; i < 40; i++) {
    const t = performance.now();
    await store.today.waitingPage({ now: o.now, after: null, limit: 12 });
    times.push(performance.now() - t);
  }
  const p95 = times.sort((a, b) => a - b)[37]!;
  o.log(`today waitingPage: p95 ${p95.toFixed(2)} ms`);
  expect(p95).toBeLessThanOrEqual(budget.waitingMs * o.budget);
  const walk = store.filters.messageWalk();
  let longest = 0;
  let pages = 0;
  for (;;) {
    const page = await walk.next(1000);
    if (!page.length) break;
    const t = performance.now();
    await store.today.digestFacts(page);
    longest = Math.max(longest, performance.now() - t);
    pages++;
    await new Promise<void>((resolve) => setTimeout(resolve));
  }
  o.log(`today digestFacts: ${pages} pages, longest ${longest.toFixed(1)} ms`);
  expect(longest).toBeLessThanOrEqual(budget.pageMs * o.budget);
}
