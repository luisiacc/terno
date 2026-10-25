import { afterEach, describe, expect, it } from "vitest";
import { classifyGaps, machineBusy, settle, type Gap } from "./timing";

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

  it("excuses none when they recur: past two per stage, or one per 5 s", () => {
    expect(classifyGaps([gap(80, 5), gap(80, 5, 100), gap(80, 5, 200)], 5_000, 50, true).descheduled).toEqual([]);
    expect(classifyGaps([gap(80, 5), gap(80, 5, 100), gap(80, 5, 200)], 15_000, 50, true).descheduled).toHaveLength(3);
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
