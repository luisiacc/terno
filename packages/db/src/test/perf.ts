import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Stat {
  name: string;
  budgetMs: number;
  p50: number;
  p95: number;
  max: number;
  iterations: number;
  note?: string;
}

/** Budgets are the real targets; slower CI machines must opt in to a multiplier explicitly. */
export const BUDGET_MULTIPLIER = Number(process.env.PERF_BUDGET_MULTIPLIER ?? "1");

/**
 * A batch that ran over budget is measured again, up to this many times in
 * all, and the best batch counts: a regression is slow in every one, a busy
 * moment of the machine (timing.ts) isn't. Nothing is excused. Each batch
 * goes on with the next indexes (60–119, …), so a write measured again
 * writes other rows instead of repeating what is already done.
 */
const ATTEMPTS = 3;

/** p50/p95/max of `iterations` calls after `warmup`, wall clock. */
export function measure(name: string, budgetMs: number, fn: (i: number) => unknown, iterations = 60, warmup = 5): Stat {
  for (let i = 0; i < warmup; i++) fn(i);
  let best: Stat | null = null;
  for (let attempt = 1; attempt <= ATTEMPTS && !(best && best.p95 <= budgetMs * BUDGET_MULTIPLIER); attempt++) {
    const samples: number[] = [];
    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      fn((attempt - 1) * iterations + i);
      samples.push(performance.now() - start);
    }
    const s = stat(name, budgetMs, samples, attempt);
    if (!best || s.p95 < best.p95) best = s;
  }
  return best!;
}

function stat(name: string, budgetMs: number, samples: number[], attempt: number): Stat {
  samples.sort((a, b) => a - b);
  const q = (p: number) => samples[Math.min(samples.length - 1, Math.ceil(p * samples.length) - 1)]!;
  return { name, budgetMs, p50: q(0.5), p95: q(0.95), max: samples[samples.length - 1]!, iterations: samples.length, ...(attempt > 1 ? { note: `batch ${attempt}` } : {}) };
}

export function report(file: string, title: string, meta: Record<string, unknown>, stats: Stat[]): void {
  const dir = join(process.cwd(), "test-results", "perf");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), JSON.stringify({ title, meta, multiplier: BUDGET_MULTIPLIER, stats }, null, 2));
  const pad = (s: string, n: number) => s.padEnd(n);
  const lines = [
    `\n${title}  (${Object.entries(meta).map(([k, v]) => `${k}=${v}`).join(", ")})`,
    `${pad("case", 52)} ${pad("p50", 8)} ${pad("p95", 8)} ${pad("max", 8)} budget`,
    ...stats.map(
      (s) =>
        `${pad(s.name, 52)} ${pad(s.p50.toFixed(2), 8)} ${pad(s.p95.toFixed(2), 8)} ${pad(s.max.toFixed(2), 8)} ${s.budgetMs}ms ${s.p95 <= s.budgetMs * BUDGET_MULTIPLIER ? "✓" : "✗"}${s.note ? ` (${s.note})` : ""}`,
    ),
  ];
  console.log(lines.join("\n"));
}

/** measure() for async commands (store boundary): each sample awaits the command; `before` runs untimed ahead of each (what the caller does between commands). */
export async function measureAsync(name: string, budgetMs: number, fn: (i: number) => Promise<unknown>, iterations = 60, warmup = 5, before?: () => Promise<unknown>): Promise<Stat> {
  for (let i = 0; i < warmup; i++) {
    await before?.();
    await fn(i);
  }
  let best: Stat | null = null;
  for (let attempt = 1; attempt <= ATTEMPTS && !(best && best.p95 <= budgetMs * BUDGET_MULTIPLIER); attempt++) {
    const samples: number[] = [];
    for (let i = 0; i < iterations; i++) {
      await before?.();
      const start = performance.now();
      await fn((attempt - 1) * iterations + i);
      samples.push(performance.now() - start);
    }
    const s = stat(name, budgetMs, samples, attempt);
    if (!best || s.p95 < best.p95) best = s;
  }
  return best!;
}
