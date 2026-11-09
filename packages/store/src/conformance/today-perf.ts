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
  // every counts.get pays this one
  const countTimes: number[] = [];
  for (let i = 0; i < 40; i++) {
    const t = performance.now();
    await store.today.needsCount(o.now);
    countTimes.push(performance.now() - t);
  }
  const countP95 = countTimes.sort((a, b) => a - b)[37]!;
  o.log(`today needsCount: p95 ${countP95.toFixed(2)} ms`);
  expect(countP95).toBeLessThanOrEqual(budget.waitingMs * o.budget);
  const walk = store.filters.messageWalk();
  let longest = 0;
  let pages = 0;
  for (;;) {
    // the page and what it reads: a store's first page may hold the walk's setting up
    const t = performance.now();
    const page = await walk.next(1000);
    if (!page.length) break;
    await store.today.digestFacts(page);
    longest = Math.max(longest, performance.now() - t);
    pages++;
    await new Promise<void>((resolve) => setTimeout(resolve));
  }
  o.log(`today digestFacts: ${pages} pages, longest ${longest.toFixed(1)} ms`);
  expect(longest).toBeLessThanOrEqual(budget.pageMs * o.budget);
  // plan 161, pass 2: the page's two reads of its ≤ 40 rows on every refresh (to archive, opened), within the waiting budget
  const ids = (await store.today.waitingPage({ now: o.now, after: null, limit: 40 })).map((p) => p.id);
  const stateTimes: number[] = [];
  for (let i = 0; i < 40; i++) {
    const t = performance.now();
    await Promise.all([store.today.digestLive(ids), store.today.digestRead(ids)]);
    stateTimes.push(performance.now() - t);
  }
  const stateP95 = stateTimes.sort((a, b) => a - b)[37]!;
  o.log(`today digest states: p95 ${stateP95.toFixed(2)} ms`);
  expect(stateP95).toBeLessThanOrEqual(budget.waitingMs * o.budget);
  // plan 166: a digest stored before its items carried a sender reads its ≤ 40 messages' senders in one go
  const messageIds = (await store.filters.messageWalk().next(40)).slice(0, 40);
  expect(messageIds.length).toBe(40);
  const senderTimes: number[] = [];
  for (let i = 0; i < 40; i++) {
    const t = performance.now();
    await store.today.senders(messageIds);
    senderTimes.push(performance.now() - t);
  }
  const senderP95 = senderTimes.sort((a, b) => a - b)[37]!;
  o.log(`today senders: p95 ${senderP95.toFixed(2)} ms`);
  expect(senderP95).toBeLessThanOrEqual(budget.waitingMs * o.budget);
}
