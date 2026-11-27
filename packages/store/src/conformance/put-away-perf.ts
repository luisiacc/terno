import { expect } from "vitest";
import { msg } from "./fixtures";
import { expectMailbox, type WorkloadMailbox } from "./perf";

/**
 * Plan 282 at 50k+ threads, the same workload on both stores: a dense week (5,000 conversations a rule archived as they
 * came, one in ten from someone you've written to), then Put away's pages deep into it, the reader's read of one, the
 * Inbox line's count, and a slice of new mail with the rule on (what ingest pays for watching it).
 */
export async function measurePutAway(o: WorkloadMailbox): Promise<void> {
  const { store, accountId } = o;
  await expectMailbox(o, {});
  const seed = performance.now();
  const friend = { name: "Ana", email: "ana@perf-friend.test" };
  await store.sync.ingest([msg({ accountId, from: { name: "Me", email: "me@perf.test" }, to: [friend], isSent: true, inInbox: false, providerMsgId: "pa-sent", rfcMessageId: "pa-sent@perf", subject: "Hola", date: o.now - 86_400_000 })], { applyFilters: false, now: o.now, classifier: null });
  await store.filters.save({ name: "Bulk", enabled: true, source: "manual", rule: { match: "any", conditions: [{ field: "fromDomain", op: "equals", value: "perf-bulk.test" }, { field: "from", op: "equals", value: friend.email }], actions: [{ type: "archive" }] } }, o.now - 86_400_000);
  const ids: number[] = [];
  for (let slice = 0; slice < 50; slice++) {
    const batch = Array.from({ length: 100 }, (_, i) => msg({ accountId, from: (slice * 100 + i) % 10 === 0 ? friend : { name: "Bulk", email: `n${i}@perf-bulk.test` }, providerMsgId: `pa-${slice}-${i}`, rfcMessageId: `pa-${slice}-${i}@perf`, subject: `Put away ${slice}-${i}`, date: o.now - 1000 - slice * 100 - i, bodyText: "x" }));
    const r = await store.sync.ingest(batch, { applyFilters: true, now: o.now - slice * 60_000, classifier: null });
    ids.push(...r.inserted);
  }
  o.log(`5,000 placements written in ${(performance.now() - seed).toFixed(0)} ms`);
  const timed = async (runs: number, work: (i: number) => Promise<unknown>) => {
    const times: number[] = [];
    for (let i = 0; i < runs; i++) {
      const start = performance.now();
      await work(i);
      times.push(performance.now() - start);
    }
    return [...times].sort((a, b) => a - b)[Math.ceil(runs * 0.95) - 1]!;
  };
  const first = await store.putAway.page({ now: o.now, limit: 100 });
  expect(first.items).toHaveLength(100);
  expect(first.items[0]!.placement.needsLook).toBe(true);
  // a page deep in the week: the cursor of the 40th
  let after = first.next;
  for (let i = 0; i < 39 && after; i++) after = (await store.putAway.page({ now: o.now, after, limit: 100 })).next;
  const top = await timed(10, () => store.putAway.page({ now: o.now, limit: 100 }));
  const deep = await timed(10, () => store.putAway.page({ now: o.now, after, limit: 100 }));
  const threads = first.items.map((i) => i.thread.id);
  const one = await timed(20, (i) => store.putAway.of(threads[i % threads.length]!, o.now));
  const look = await timed(10, () => store.putAway.needsLook({ now: o.now, after: 0 }));
  expect((await store.putAway.needsLook({ now: o.now, after: 0 })).count).toBe(500);
  // new mail with the rule on: the watch's reads and one placement per conversation it puts away
  let n = 0;
  const ingest = await timed(5, () => store.sync.ingest(Array.from({ length: 20 }, (_, i) => msg({ accountId, from: { name: "Bulk", email: `late${i}@perf-bulk.test` }, providerMsgId: `pa-late-${n}-${i}`, rfcMessageId: `pa-late-${n++}-${i}@perf`, subject: `Late ${i}`, date: o.now - 10, bodyText: "x" })), { applyFilters: true, now: o.now, classifier: null }));
  // Stop's second step: the rule off, what it still keeps away (the reader counts it; Bring back lists it), once the week is full
  const placed = (await store.putAway.of(threads[0]!, o.now))!;
  const rule = placed.detail as { filterId: number; ruleHash: string };
  await store.filters.save({ id: rule.filterId, name: "Bulk", enabled: false, source: "manual", rule: (await store.filters.get(rule.filterId))!.rule }, o.now);
  const byRule = await timed(5, () => store.putAway.byRule(rule.filterId, rule.ruleHash, o.now));
  expect((await store.putAway.byRule(rule.filterId, rule.ruleHash, o.now)).length).toBeGreaterThanOrEqual(5000);
  // the rule goes with the workload: one that follows on this mailbox may need it without filters (forwards, plan 116)
  await store.filters.delete(rule.filterId);
  o.log(`Put away: the first page ${top.toFixed(2)} ms, the 40th ${deep.toFixed(2)} ms, the reader's ${one.toFixed(2)} ms, the Inbox line's count ${look.toFixed(2)} ms, 20 new with the rule ${ingest.toFixed(2)} ms, a stopped rule's ${byRule.toFixed(2)} ms`);
  expect(byRule).toBeLessThanOrEqual(60 * o.budget);
  expect(top).toBeLessThanOrEqual(25 * o.budget);
  expect(deep).toBeLessThanOrEqual(25 * o.budget);
  expect(one).toBeLessThanOrEqual(2 * o.budget);
  expect(look).toBeLessThanOrEqual(25 * o.budget);
  expect(ingest).toBeLessThanOrEqual(60 * o.budget);
}
