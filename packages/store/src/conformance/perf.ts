/**
 * Measuring our own cost on a machine that may be busy with other work
 * (plan 18): throughput as this process's CPU time (another process using
 * the CPU doesn't add to it), latencies as the best of several rounds (a
 * preemption doesn't repeat, a regression does), stalls as the longest
 * stretch between two of our own yields, memory as heap plus ArrayBuffers
 * after a full collection.
 */
type Proc = { cpuUsage(prev?: { user: number; system: number }): { user: number; system: number }; memoryUsage(): { heapUsed: number; arrayBuffers: number; external: number } };
const proc = (globalThis as unknown as { process: Proc }).process;
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};

export const PERF_MULT = Number(env.PERF_BUDGET_MULTIPLIER ?? "1");
export const perfLog = (line: string) => (globalThis as { console?: { log(s: string): void } }).console?.log(line);

/** CPU milliseconds this process spent in `fn` (user + system). */
export async function cpuMs<T>(fn: () => Promise<T> | T): Promise<{ result: T; cpu: number; wall: number }> {
  const c0 = proc.cpuUsage();
  const w0 = performance.now();
  const result = await fn();
  const used = proc.cpuUsage(c0);
  return { result, cpu: (used.user + used.system) / 1000, wall: performance.now() - w0 };
}

export function percentile(sorted: readonly number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

/** p50/p95/p99 of each round of `run`, keeping the best round per statistic. */
export function bestRounds(rounds: number, run: () => number[]): { p50: number; p95: number; p99: number; max: number } {
  const best = { p50: Infinity, p95: Infinity, p99: Infinity, max: Infinity };
  for (let r = 0; r < rounds; r++) {
    const s = run().sort((a, b) => a - b);
    best.p50 = Math.min(best.p50, percentile(s, 0.5));
    best.p95 = Math.min(best.p95, percentile(s, 0.95));
    best.p99 = Math.min(best.p99, percentile(s, 0.99));
    best.max = Math.min(best.max, s[s.length - 1]!);
  }
  return best;
}

const macrotask = () => new Promise<void>((r) => setTimeout(r, 0));

/** A yield that records the longest stretch the caller ran between two yields. */
export function stallMeter() {
  let resumed = performance.now();
  let max = 0;
  let count = 0;
  return {
    yield: async () => {
      max = Math.max(max, performance.now() - resumed);
      count++;
      await macrotask();
      resumed = performance.now();
    },
    done: () => Math.max(max, performance.now() - resumed),
    get yields() {
      return count;
    },
  };
}

/** Heap and ArrayBuffer bytes after a full collection (needs --expose-gc, as the perf project runs). */
export function memoryBytes(): number {
  const gc = (globalThis as { gc?: () => void }).gc;
  gc?.();
  gc?.();
  const m = proc.memoryUsage();
  return m.heapUsed + m.arrayBuffers;
}
