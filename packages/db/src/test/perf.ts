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

export function measure(name: string, budgetMs: number, fn: (i: number) => unknown, iterations = 60, warmup = 5): Stat {
  for (let i = 0; i < warmup; i++) fn(i);
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    fn(i);
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const q = (p: number) => samples[Math.min(samples.length - 1, Math.ceil(p * samples.length) - 1)]!;
  return { name, budgetMs, p50: q(0.5), p95: q(0.95), max: samples[samples.length - 1]!, iterations };
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
        `${pad(s.name, 52)} ${pad(s.p50.toFixed(2), 8)} ${pad(s.p95.toFixed(2), 8)} ${pad(s.max.toFixed(2), 8)} ${s.budgetMs}ms ${s.p95 <= s.budgetMs * BUDGET_MULTIPLIER ? "✓" : "✗"}`,
    ),
  ];
  console.log(lines.join("\n"));
}
