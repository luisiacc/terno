/**
 * Timing that a loaded machine doesn't fail, and a quiet one judges as
 * strictly as ever. Wall-clock time is what a user waits, so it stays the
 * measure. What a busy machine adds is time the OS held our thread: the event
 * loop was busy (running a callback, or blocked in one) but the thread wasn't
 * on a CPU. No counter tells that apart from a synchronous wait of ours
 * (fsync, a lock) on macOS, so:
 *
 * - what can be measured again is (measure() in perf.ts retries a batch
 *   that ran over: a regression is slow every time, a busy moment isn't);
 * - what can't is excused only on a busy machine (a 1-, 5- or 15-minute load
 *   of at least half the cores, or PERF_MACHINE=busy; PERF_MACHINE=quiet
 *   turns it off), and only when rare: a sample off-CPU for over half of it
 *   counts at its CPU time while such samples are at most a tenth; a stall (a
 *   gap between 1 ms ticks with the loop busy) in which the thread used at
 *   most the budget of CPU is excused at most twice per stage (or once a
 *   second: work that waits in every slice holds it hundreds of times), each
 *   under 2 s. Past that, all count in full.
 *
 * On a quiet machine nothing is excused. A slower computation shows as CPU
 * time and fails either way. Plain JS for the IndexedDB package (no Node
 * types there).
 */

interface NodeProcess {
  threadCpuUsage(): { user: number; system: number };
  env: Record<string, string | undefined>;
  getBuiltinModule(id: "node:os"): { loadavg(): number[]; availableParallelism(): number };
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

/**
 * Whether other work is loading the machine now: then off-CPU time may be the
 * OS's and rare holds are excused. Read at each decision (load moves).
 */
export function machineBusy(): boolean {
  const forced = proc.env.PERF_MACHINE;
  if (forced === "busy" || forced === "quiet") return forced === "busy";
  const os = proc.getBuiltinModule("node:os");
  // the longer averages too: the user's own work is sustained, and the 1-minute one dips below the line now and then
  return Math.max(...os.loadavg()) >= os.availableParallelism() / 2;
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
 * Each sample's wall time, with the descheduled ones at their CPU time if the
 * machine is busy and they are few enough. Returns the times in the samples'
 * order and how many were excused.
 */
export function settle(samples: readonly Sample[], busy = machineBusy()): { ms: number[]; excused: number } {
  const off = samples.filter(isDescheduled).length;
  const excuse = busy && off <= Math.floor(samples.length * DESCHEDULED_SHARE);
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
  return Math.max(2, Math.floor(stageMs / 1_000));
}

/** the longest hold excused: a machine paging under memory pressure holds a thread for hundreds of ms */
export const HOLD_LIMIT_MS = 2_000;

/** Splits over-budget gaps into descheduled (excused on a busy machine, if rare and under the hold limit) and ours. */
export function classifyGaps(over: readonly Gap[], stageMs: number, budgetMs: number, busy = machineBusy()): { descheduled: Gap[]; ours: Gap[] } {
  const candidates = over.filter((g) => g.cpu <= budgetMs && g.busy <= HOLD_LIMIT_MS);
  if (!busy || candidates.length > deschedulingAllowance(stageMs)) return { descheduled: [], ours: [...over] };
  return { descheduled: candidates, ours: over.filter((g) => !candidates.includes(g)) };
}

/**
 * Ticks every 1 ms and records each gap: how long the loop was busy in it
 * (computing or blocked; an idle loop whose timer the OS fired late isn't a
 * stall) and how much CPU the thread had.
 */
export function watchLoop(budgetMs: number): { stop(): LoopReport } {
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
      const { descheduled, ours } = classifyGaps(over, ms, budgetMs);
      return { over, longest, descheduled, stall: Math.max(longestOk, ...ours.map((g) => g.busy), ...descheduled.map((g) => g.cpu)), ms };
    },
  };
}

export const describeGap = (g: Gap) => `${g.busy.toFixed(0)} ms (wall ${g.wall.toFixed(0)}, cpu ${g.cpu.toFixed(0)})`;
