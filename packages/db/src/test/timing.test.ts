import { afterEach, describe, expect, it } from "vitest";
import { classifyGaps, holdsExcusable, machineBusy, pausedIn, settle, stallLessGc, type Gap, type LoopReport } from "./timing";

const gap = (busy: number, cpu: number, at = 0): Gap => ({ start: at, end: at + busy, wall: busy, busy, cpu });
const rare = () => [...Array.from({ length: 19 }, () => ({ wall: 2, cpu: 1.9 })), { wall: 9, cpu: 2 }];

describe("settle", () => {
  it("on a busy machine, counts a rare descheduled sample at its CPU time and keeps the rest at wall time", () => {
    const { ms, excused } = settle(rare(), true);
    expect(excused).toBe(1);
    expect(ms.at(-1)).toBe(2);
    expect(ms.slice(0, 19).every((x) => x === 2)).toBe(true);
  });

  it("on a quiet machine, excuses nothing", () => {
    const { ms, excused } = settle(rare(), false);
    expect(excused).toBe(0);
    expect(ms.at(-1)).toBe(9);
  });

  it("excuses nothing once off-CPU time is common: a wait in every call is ours", () => {
    const samples = Array.from({ length: 20 }, (_, i) => (i % 4 === 0 ? { wall: 9, cpu: 2 } : { wall: 2, cpu: 1.9 }));
    const { ms, excused } = settle(samples, true);
    expect(excused).toBe(0);
    expect(Math.max(...ms)).toBe(9);
  });

  it("never excuses a sample that was on the CPU: slower code stays slower", () => {
    const { ms, excused } = settle([{ wall: 9, cpu: 8.5 }, ...Array.from({ length: 19 }, () => ({ wall: 2, cpu: 2 }))], true);
    expect(excused).toBe(0);
    expect(ms[0]).toBe(9);
  });
});

describe("classifyGaps", () => {
  it("on a busy machine, excuses a few stalls the OS held, under the hard limit", () => {
    const { descheduled, ours } = classifyGaps([gap(80, 10), gap(70, 60), gap(3000, 5)], 5_000, 50, true);
    expect(descheduled.map((g) => g.busy)).toEqual([80]);
    expect(ours.map((g) => g.busy)).toEqual([70, 3000]);
  });

  it("on a quiet machine, excuses none", () => {
    expect(classifyGaps([gap(80, 10)], 5_000, 50, false).descheduled).toEqual([]);
  });

  it("excuses none when they recur: past two per stage, or one a second", () => {
    expect(classifyGaps([gap(80, 5), gap(80, 5, 100), gap(80, 5, 200)], 2_000, 50, true).descheduled).toEqual([]);
    expect(classifyGaps([gap(80, 5), gap(80, 5, 100), gap(80, 5, 200)], 3_500, 50, true).descheduled).toHaveLength(3);
  });
});

describe("holdsExcusable", () => {
  it("lets the machine's few holds through", () => {
    expect(holdsExcusable([60, 300, 40, 90], 6_000)).toBe(true);
  });

  it("a long wait in every slice can't buy its own allowance with the time it adds", () => {
    // 100 waits of 1.1 s: a 110 s stage, but its time outside them is under a second
    expect(holdsExcusable(Array.from({ length: 100 }, () => 1_100), 110_500)).toBe(false);
  });

  it("holds over a fifth of the stage are ours, however few", () => {
    expect(holdsExcusable([700, 600], 5_000)).toBe(false);
  });
});

describe("stallLessGc", () => {
  const report = (over: Gap[], within = 10, descheduled: Gap[] = []): LoopReport => ({ over, longest: over[0]!, descheduled, stall: 0, within, held: 0, ms: 5_000 });

  it("leaves out a collection inside the gap", () => {
    expect(stallLessGc(report([gap(60, 60, 1_000)]), [{ start: 1_010, end: 1_050 }])).toBe(20);
  });

  it("a long collection elsewhere in the stage excuses nothing: a 60 ms block stays 60 ms", () => {
    // the stall less the stage's longest collection would have been 16 ms here
    expect(stallLessGc(report([gap(60, 60, 1_000), gap(50, 50, 3_000)]), [{ start: 3_002, end: 3_046 }])).toBe(60);
  });

  it("counts an excused gap at its CPU time, and never below the longest gap within budget", () => {
    const brief = gap(80, 5, 1_000);
    expect(stallLessGc(report([brief], 12, [brief]), [])).toBe(12);
    const held = gap(80, 30, 1_000);
    expect(stallLessGc(report([held], 12, [held]), [])).toBe(30);
  });

  it("measures only the overlap", () => {
    expect(pausedIn({ start: 100, end: 200 }, [{ start: 90, end: 110 }, { start: 190, end: 250 }, { start: 300, end: 400 }])).toBe(20);
  });
});

describe("machineBusy", () => {
  const before = process.env.PERF_MACHINE;
  afterEach(() => {
    if (before === undefined) delete process.env.PERF_MACHINE;
    else process.env.PERF_MACHINE = before;
  });

  it("follows PERF_MACHINE when it is set", () => {
    process.env.PERF_MACHINE = "quiet";
    expect(machineBusy()).toBe(false);
    process.env.PERF_MACHINE = "busy";
    expect(machineBusy()).toBe(true);
  });
});
