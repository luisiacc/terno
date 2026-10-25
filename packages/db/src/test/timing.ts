/**
 * Timing that a loaded machine doesn't fail. Wall-clock time is what a user
 * waits, so it stays the measure; what is taken out is time the OS held our
 * thread: the event loop was busy (running a callback, or blocked in one) but
 * the thread wasn't on a CPU. That is preemption by other processes, but also
 * a synchronous wait of ours (fsync, a lock, a page fault), which no counter
 * tells apart on macOS, so it is excused only when it is the exception:
 *
 * - a sample is "descheduled" when its thread was off-CPU for over half of it;
 *   it then counts at the CPU time it used. Past a tenth of the samples none
 *   are excused: a wait that common is ours.
 * - a stall (a gap between 1 ms ticks with the loop busy) is descheduled when
 *   the thread used at most the budget of CPU in it; at most two such stalls,
 *   or one per 10 s of the stage, each under a hard limit. Past that, all
 *   count in full.
 *
 * A slower computation shows as CPU time and fails exactly as before; only
 * occasional off-CPU time is forgiven. Plain JS for the IndexedDB package
 * (no Node types there).
 */

interface NodeProcess {
  threadCpuUsage(): { user: number; system: number };
}
interface NodePerformance {
  now(): number;
  eventLoopUtilization(): { idle: number; active: number; utilization: number };
}

const proc = (globalThis as unknown as { process: NodeProcess }).process;
const perf = (globalThis as unknown as { performance: NodePerformance }).performance;

/** this thread's CPU time, ms */
export function threadCpuMs(): number {
  const u = proc.threadCpuUsage();
  return (u.user + u.system) / 1000;
}

/** how long the event loop has been busy since it started, ms */
export function loopActiveMs(): number {
  return perf.eventLoopUtilization().active;
}

export interface Sample {
  /** wall-clock ms */
  wall: number;
  /** of which the thread was on a CPU */
  cpu: number;
}

/** the share of samples that may be excused as descheduled */
export const DESCHEDULED_SHARE = 0.1;

const isDescheduled = (s: Sample) => s.wall - s.cpu > s.wall / 2;

/**
 * Each sample's wall time, with the descheduled ones (if they are few enough)
 * at their CPU time. Returns the times in the samples' order and how many
 * were excused.
 */
export function settle(samples: readonly Sample[]): { ms: number[]; excused: number } {
  const off = samples.filter(isDescheduled).length;
  const excuse = off <= Math.floor(samples.length * DESCHEDULED_SHARE);
  return { ms: samples.map((s) => (excuse && isDescheduled(s) ? Math.min(s.wall, s.cpu) : s.wall)), excused: excuse ? off : 0 };
}

/** Times a synchronous call: wall and thread CPU. */
export function sampleSync(fn: () => unknown): Sample {
  const cpu = threadCpuMs();
  const start = perf.now();
  fn();
  const wall = perf.now() - start;
  return { wall, cpu: threadCpuMs() - cpu };
}

/**
 * Times an asynchronous call. Its CPU is the thread's while the loop was
 * active; time the loop sat idle (timers, I/O) is the call's own latency and
 * stays in, so `cpu` here is wall minus the active time the thread was off a
 * CPU.
 */
export async function sampleAsync<T>(fn: () => Promise<T>): Promise<Sample & { result: T }> {
  const cpu0 = threadCpuMs();
  const active0 = loopActiveMs();
  const start = perf.now();
  const result = await fn();
  const wall = perf.now() - start;
  const offCpu = Math.max(0, loopActiveMs() - active0 - (threadCpuMs() - cpu0));
  return { result, wall, cpu: Math.max(0, wall - offCpu) };
}

export interface Gap {
  start: number;
  end: number;
  /** wall-clock ms between the two ticks */
  wall: number;
  /** of which the event loop was busy: the stall a user sees */
  busy: number;
  /** of which the thread was on a CPU */
  cpu: number;
}

export interface LoopReport {
  /** every gap whose busy time was over the budget */
  over: Gap[];
  /** the longest busy gap, excused or not */
  longest: Gap;
  /** the over-budget gaps excused as descheduled */
  descheduled: Gap[];
  /** the longest stall that counts: the gate */
  stall: number;
  /** ms the monitor ran */
  ms: number;
}

/** stalls a stage may excuse as descheduled */
export function deschedulingAllowance(stageMs: number): number {
  return Math.max(2, Math.floor(stageMs / 10_000));
}

/** Splits over-budget gaps into descheduled (excused, if rare and under the hard limit) and ours. */
export function classifyGaps(over: readonly Gap[], stageMs: number, budgetMs: number, hardLimitMs = budgetMs * 5): { descheduled: Gap[]; ours: Gap[] } {
  const candidates = over.filter((g) => g.cpu <= budgetMs && g.busy <= hardLimitMs);
  if (candidates.length > deschedulingAllowance(stageMs)) return { descheduled: [], ours: [...over] };
  return { descheduled: candidates, ours: over.filter((g) => !candidates.includes(g)) };
}

/**
 * Ticks every 1 ms and records each gap: how long the loop was busy in it
 * (computing or blocked; an idle loop whose timer the OS fired late isn't a
 * stall) and how much CPU the thread had.
 */
export function watchLoop(budgetMs: number, hardLimitMs = budgetMs * 5): { stop(): LoopReport } {
  const over: Gap[] = [];
  const started = perf.now();
  let longest: Gap = { start: started, end: started, wall: 0, busy: 0, cpu: 0 };
  let last = started;
  let lastCpu = threadCpuMs();
  let lastActive = loopActiveMs();
  let longestOk = 0;
  const sample = () => {
    const now = perf.now();
    const cpu = threadCpuMs();
    const active = loopActiveMs();
    const gap: Gap = { start: last, end: now, wall: now - last, busy: Math.min(now - last, active - lastActive), cpu: cpu - lastCpu };
    if (gap.busy > budgetMs) over.push(gap);
    else longestOk = Math.max(longestOk, gap.busy);
    if (gap.busy > longest.busy) longest = gap;
    last = now;
    lastCpu = cpu;
    lastActive = active;
  };
  const timer = setInterval(sample, 1);
  return {
    stop() {
      // a block that ended just now
      sample();
      clearInterval(timer);
      const ms = perf.now() - started;
      const { descheduled, ours } = classifyGaps(over, ms, budgetMs, hardLimitMs);
      return { over, longest, descheduled, stall: Math.max(longestOk, ...ours.map((g) => g.busy), ...descheduled.map((g) => g.cpu)), ms };
    },
  };
}

export const describeGap = (g: Gap) => `${g.busy.toFixed(0)} ms (wall ${g.wall.toFixed(0)}, cpu ${g.cpu.toFixed(0)})`;
