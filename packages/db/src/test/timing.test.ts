import { describe, expect, it } from "vitest";
import { classifyGaps, settle, type Gap } from "./timing";

const gap = (busy: number, cpu: number, at = 0): Gap => ({ start: at, end: at + busy, wall: busy, busy, cpu });

describe("settle", () => {
  it("counts a rare descheduled sample at its CPU time and keeps the rest at wall time", () => {
    const samples = [...Array.from({ length: 19 }, () => ({ wall: 2, cpu: 1.9 })), { wall: 9, cpu: 2 }];
    const { ms, excused } = settle(samples);
    expect(excused).toBe(1);
    expect(ms.at(-1)).toBe(2);
    expect(ms.slice(0, 19).every((x) => x === 2)).toBe(true);
  });

  it("excuses nothing once off-CPU time is common: a wait in every call is ours", () => {
    const samples = Array.from({ length: 20 }, (_, i) => (i % 4 === 0 ? { wall: 9, cpu: 2 } : { wall: 2, cpu: 1.9 }));
    const { ms, excused } = settle(samples);
    expect(excused).toBe(0);
    expect(Math.max(...ms)).toBe(9);
  });

  it("never excuses a sample that was on the CPU: slower code stays slower", () => {
    const { ms, excused } = settle([{ wall: 9, cpu: 8.5 }, ...Array.from({ length: 19 }, () => ({ wall: 2, cpu: 2 }))]);
    expect(excused).toBe(0);
    expect(ms[0]).toBe(9);
  });
});

describe("classifyGaps", () => {
  it("excuses a few stalls the OS held, under the hard limit", () => {
    const { descheduled, ours } = classifyGaps([gap(80, 10), gap(70, 60), gap(300, 5)], 5_000, 50);
    expect(descheduled.map((g) => g.busy)).toEqual([80]);
    expect(ours.map((g) => g.busy)).toEqual([70, 300]);
  });

  it("excuses none when they recur: past two per stage, or one per 10 s", () => {
    expect(classifyGaps([gap(80, 5), gap(80, 5, 100), gap(80, 5, 200)], 5_000, 50).descheduled).toEqual([]);
    expect(classifyGaps([gap(80, 5), gap(80, 5, 100), gap(80, 5, 200)], 30_000, 50).descheduled).toHaveLength(3);
  });
});
