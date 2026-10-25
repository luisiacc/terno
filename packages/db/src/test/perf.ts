import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sampleAsync, sampleSync, settle, type Sample } from "./timing";

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
 * p50/p95/max of `iterations` calls after `warmup`. Wall time, with calls the
 * OS descheduled counted at their CPU time while they are rare (timing.ts).
 */
export function measure(name: string, budgetMs: number, fn: (i: number) => unknown, iterations = 60, warmup = 5): Stat {
  for (let i = 0; i < warmup; i++) fn(i);
  const samples: Sample[] = [];
  for (let i = 0; i < iterations; i++) samples.push(sampleSync(() => fn(i)));
  return stat(name, budgetMs, samples);
}

/** Percentiles of settled samples (timing.ts), with how many were excused as descheduled. */
export function stat(name: string, budgetMs: number, samples: readonly Sample[]): Stat {
  const { ms, excused } = settle(samples);
  ms.sort((a, b) => a - b);
  const q = (p: number) => ms[Math.min(ms.length - 1, Math.ceil(p * ms.length) - 1)]!;
  return { name, budgetMs, p50: q(0.5), p95: q(0.95), max: ms[ms.length - 1]!, iterations: ms.length, ...(excused ? { note: `${excused} descheduled` } : {}) };
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

/** measure() for async commands (store boundary): each sample awaits the command. */
export async function measureAsync(name: string, budgetMs: number, fn: (i: number) => Promise<unknown>, iterations = 60, warmup = 5): Promise<Stat> {
  for (let i = 0; i < warmup; i++) await fn(i);
  const samples: Sample[] = [];
  for (let i = 0; i < iterations; i++) samples.push(await sampleAsync(() => fn(i)));
  return stat(name, budgetMs, samples);
}
