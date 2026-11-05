import { FORWARD_DELAY_MS, type FilterRule } from "@terno/core";
import { expect } from "vitest";
import { msg } from "./fixtures";
import { expectMailbox, type WorkloadMailbox } from "./perf";

/**
 * Plan 116 at 50k+ threads, the same workload on both stores: a category
 * that forwards and a filter that forwards, 2,000 live messages arriving in
 * slices of 200 (half of them filed into the category), and what the queue
 * reads while hundreds of forwards wait. What a slice's planning costs
 * follows the slice, never the mailbox; the queue's reads follow their page.
 */
export async function measureForwards(o: WorkloadMailbox): Promise<void> {
  const { store, accountId } = o;
  await expectMailbox(o, { filters: 0 });
  expect(await store.forwards.waitingCount()).toBe(0);
  const cat = await store.categories.create("Facturas reenviadas", "amber");
  await store.forwards.setCategory(cat.id, { addresses: [{ name: "Ana", email: "ana@books.test" }], enabled: true }, o.now);
  const fileRule: FilterRule = { match: "all", conditions: [{ field: "subject", op: "contains", value: "factura" }], actions: [{ type: "addCategory", categoryId: cat.id }] };
  await store.filters.save({ name: "Facturas", enabled: true, source: "manual", rule: fileRule }, o.now);
  const forwardRule: FilterRule = { match: "all", conditions: [{ field: "subject", op: "contains", value: "recibo" }], actions: [{ type: "forward", to: [{ name: "Luis", email: "luis@books.test" }] }] };
  await store.filters.save({ name: "Recibos", enabled: true, source: "manual", rule: forwardRule }, o.now);

  const plans: number[] = [];
  let made = 0;
  for (let slice = 0; slice < 10; slice++) {
    const at = o.now + 1000 + slice;
    const batch = Array.from({ length: 200 }, (_, i) => msg({ accountId, subject: i % 2 ? `Tu factura ${slice}-${i}` : i % 5 ? `Hola ${slice}-${i}` : `Tu recibo ${slice}-${i}`, date: at - 60_000 }));
    const r = await store.sync.ingest(batch, { applyFilters: true, now: at, classifier: null, forwardEligible: true });
    const start = performance.now();
    made += (await store.forwards.plan({ messageIds: r.inserted, threadIds: r.touched, agentFiles: false, now: at })).length;
    plans.push(performance.now() - start);
  }
  expect(made).toBeGreaterThanOrEqual(1000);
  const reads: number[] = [];
  const due = o.now + 1000 + FORWARD_DELAY_MS + 20;
  for (let i = 0; i < 40; i++) {
    const start = performance.now();
    await store.forwards.work(due, 50);
    await store.forwards.list(due, 200);
    await store.forwards.holds(due);
    await store.forwards.nextDue();
    await store.forwards.waitingCount();
    reads.push(performance.now() - start);
  }
  const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.95) - 1]!;
  o.log(`plan(200 live) p95 ${p95(plans).toFixed(2)} ms · the queue's reads p95 ${p95(reads).toFixed(2)} ms (${made} forwards waiting)`);
  expect(p95(plans)).toBeLessThanOrEqual(15 * o.budget);
  expect(p95(reads)).toBeLessThanOrEqual(10 * o.budget);
}
