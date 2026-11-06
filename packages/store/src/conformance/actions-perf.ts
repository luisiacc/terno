import type { FilterRule } from "@terno/core";
import { expect } from "vitest";
import { expectMailbox, type WorkloadMailbox } from "./perf";

const WINDOW = 4000;
const WINDOW_PATTERN = 1000;

/**
 * Plan 143 at 50k+ threads, the same on both stores: a sentence's whole walk, as the backend runs it, with a turn
 * between windows. What it holds is the longest uninterrupted step (the slicer's budget, revision 11) and the whole
 * walk, with a pattern and without, sparse (few rows match) and dense (most do).
 */
export async function measureActionWalk(o: WorkloadMailbox, budget: { stepMs: number; totalMs: number }): Promise<void> {
  const { store } = o;
  await expectMailbox(o, {});
  const age = { field: "ageDays" as const, op: "gt" as const, value: 0 };
  const cases: { name: string; rule: FilterRule; size: number; dense: boolean }[] = [
    { name: "sparse, words", size: WINDOW, dense: false, rule: { match: "all", conditions: [{ field: "subject", op: "contains", value: "zzqq-nothing" }], actions: [{ type: "archive" }] } },
    { name: "sparse, pattern", size: WINDOW_PATTERN, dense: false, rule: { match: "all", conditions: [{ field: "subject", op: "matches", value: "zzqq|nothing-here|never" }], actions: [{ type: "archive" }] } },
    { name: "dense, age", size: WINDOW, dense: true, rule: { match: "all", conditions: [age], actions: [{ type: "archive" }] } },
    { name: "dense, pattern", size: WINDOW_PATTERN, dense: true, rule: { match: "all", conditions: [{ field: "fromDomain", op: "matches", value: "." }, age], actions: [{ type: "archive" }] } },
  ];
  for (const c of cases) {
    const walk = store.filters.messageWalk();
    const seen = new Set<number>();
    let longest = 0;
    let messages = 0;
    const started = performance.now();
    for (;;) {
      const step = performance.now();
      const page = await walk.next(c.size);
      if (!page.length) break;
      messages += page.length;
      const matched = await store.filters.matchMessages(c.rule, o.now, page);
      const threads = matched.length ? (await store.filters.threadsOf(matched)).filter((id) => !seen.has(id)) : [];
      for (const id of threads) seen.add(id);
      if (threads.length) await store.filters.actionFacts(threads);
      longest = Math.max(longest, performance.now() - step);
      await new Promise<void>((resolve) => setTimeout(resolve));
    }
    const total = performance.now() - started;
    o.log(`${c.name}: ${messages} messages, ${seen.size} threads, longest step ${longest.toFixed(1)} ms, all ${total.toFixed(0)} ms`);
    if (c.dense) expect(seen.size).toBeGreaterThan(40_000);
    else expect(seen.size).toBe(0);
    expect(longest, `${c.name}: longest step`).toBeLessThanOrEqual(budget.stepMs * o.budget);
    expect(total, `${c.name}: whole walk`).toBeLessThanOrEqual(budget.totalMs * o.budget);
  }
}
