import { CategorizerModel } from "@terno/core";
import { expect } from "vitest";
import type { MailStore } from "../mail-store";
import { expectMailbox, type WorkloadMailbox } from "./perf";

/**
 * Plan 134 at 50k+ threads, the same workload on both stores: a category the user filled with thousands of threads next
 * to smaller ones, what the assist reads to know the categories, and an AI filing with every rule re-read.
 */
export async function measureCategoryEvidence(o: WorkloadMailbox): Promise<void> {
  const { store } = o;
  await expectMailbox(o, {});
  const threads: number[] = [];
  let cursor: Awaited<ReturnType<MailStore["threads"]["list"]>>["nextCursor"] | undefined;
  do {
    const page = await store.threads.list({ view: "inbox", limit: 500, cursor: cursor ?? undefined });
    threads.push(...page.items.map((t) => t.id));
    cursor = page.nextCursor;
  } while (cursor && threads.length < 5000);
  expect(threads.length).toBeGreaterThanOrEqual(5000);
  const big = await store.categories.create("Big", "amber");
  const small = await store.categories.create("Small", "cyan");
  for (let i = 0; i < 4900; i += 200) await store.categories.add({ categoryId: big.id, threadIds: threads.slice(i, Math.min(i + 200, 4900)), addedBy: "bulk", now: o.now + i });
  await store.categories.add({ categoryId: small.id, threadIds: threads.slice(4900, 4905), addedBy: "user", now: o.now });
  for (let i = 0; i < 20; i++) await store.categories.create(`Empty ${i}`, "emerald");

  const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.95) - 1]!;
  const reads: number[] = [];
  for (let i = 0; i < 30; i++) {
    const start = performance.now();
    const rows = await store.categorize.categoryEvidence({ perCategory: 3, limit: 100 });
    reads.push(performance.now() - start);
    expect(rows.find((r) => r.id === big.id)!.samples).toHaveLength(3);
  }
  const writes: number[] = [];
  const model = new CategorizerModel({ decayRef: o.now });
  for (const threadId of threads.slice(4910, 4930)) {
    const start = performance.now();
    await store.categorize.recordAiFiling({ threadId, categoryId: big.id, p: 0.99, explain: [], suggestExplain: [], sender: "x@example.com", encoded: new Uint32Array(), model, now: o.now });
    writes.push(performance.now() - start);
  }
  o.log(`categoryEvidence p95 ${p95(reads).toFixed(2)} ms · recordAiFiling p95 ${p95(writes).toFixed(2)} ms`);
  // both follow the categories and a few rows per category, never the mailbox
  expect(p95(reads)).toBeLessThanOrEqual(15 * o.budget);
  expect(p95(writes)).toBeLessThanOrEqual(15 * o.budget);
}
