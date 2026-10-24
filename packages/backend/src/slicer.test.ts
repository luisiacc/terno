import { describe, expect, it } from "vitest";
import { BULK_SLICE, SliceSizer } from "./slicer";

/** Runs n items through the sizer on a machine where each item costs `perItem` ms (plus `overhead` per slice). */
function simulate(sizer: SliceSizer, n: number, cost: (i: number) => { perItem: number; overhead?: number }) {
  const slices: { size: number; ms: number }[] = [];
  for (let done = 0, i = 0; done < n; i++) {
    const size = Math.min(sizer.size, n - done);
    const c = cost(i);
    const ms = size * c.perItem + (c.overhead ?? 0);
    slices.push({ size, ms });
    sizer.record(size, ms);
    done += size;
  }
  return slices;
}

describe("time-budgeted slices", () => {
  it("starts with a small probe, then grows at most ×1.25 (and at least +1) toward the target", () => {
    const s = new SliceSizer();
    expect(s.size).toBe(BULK_SLICE.initial);
    const slices = simulate(s, 20_000, () => ({ perItem: 0.01, overhead: 0.5 }));
    for (let i = 1; i < slices.length; i++) expect(slices[i]!.size).toBeLessThanOrEqual(Math.max(slices[i - 1]!.size + 1, Math.floor(slices[i - 1]!.size * 1.25)));
    // an idle machine reaches the ceiling or the target, it isn't stuck small
    expect(Math.max(...slices.map((x) => x.size))).toBeGreaterThan(1000);
    expect(Math.max(...slices.map((x) => x.ms))).toBeLessThanOrEqual(BULK_SLICE.targetMs + 1);
  });

  it("never stays at one item: from the floor it still grows (+1 when ×1.25 rounds down)", () => {
    const s = new SliceSizer({ ...BULK_SLICE, initial: 1 });
    const slices = simulate(s, 200, () => ({ perItem: 0.1 }));
    expect(slices.slice(0, 4).map((x) => x.size)).toEqual([1, 2, 3, 4]);
  });

  it("when the machine gets 10× slower, the next slice at least halves and they settle back under the target", () => {
    const s = new SliceSizer();
    const slices = simulate(s, 50_000, (i) => ({ perItem: i < 60 ? 0.02 : 0.2 }));
    const at = slices.findIndex((x) => x.ms > BULK_SLICE.targetMs);
    expect(at).toBeGreaterThan(0);
    expect(slices[at + 1]!.size).toBeLessThanOrEqual(slices[at]!.size / 2);
    // one overrun, then every slice fits again
    for (const x of slices.slice(at + 1)) expect(x.ms).toBeLessThanOrEqual(BULK_SLICE.targetMs);
  });

  it("items of very different cost (a thread can cost 10× another): overruns stay rare instead of oscillating", () => {
    const s = new SliceSizer();
    // every 7th item is heavy
    let i = 0;
    const slices: number[] = [];
    for (let done = 0; done < 3000; ) {
      const size = s.size;
      let ms = 0;
      for (let k = 0; k < size; k++) ms += (i++ % 7 === 0 ? 2.5 : 0.25);
      slices.push(ms);
      s.record(size, ms);
      done += size;
    }
    const overruns = slices.filter((ms) => ms > BULK_SLICE.targetMs).length;
    expect(overruns / slices.length).toBeLessThan(0.1);
    expect(Math.max(...slices)).toBeLessThan(BULK_SLICE.targetMs * 2.5);
  });

  it("a single fast slice on a slow machine doesn't buy a long one", () => {
    const s = new SliceSizer();
    simulate(s, 2000, () => ({ perItem: 0.3 }));
    const before = s.size;
    s.record(before, before * 0.01); // a lucky one
    expect(s.size).toBeLessThanOrEqual(Math.max(before + 1, Math.floor(before * 1.25)));
    expect(s.size * 0.3).toBeLessThanOrEqual(BULK_SLICE.targetMs * 1.25);
  });

  it("keeps to its floor and ceiling", () => {
    const s = new SliceSizer({ targetMs: 15, initial: 50, floor: 2, ceiling: 60 });
    s.record(50, 10_000);
    expect(s.size).toBe(2);
    for (let i = 0; i < 100; i++) s.record(s.size, 0.001);
    expect(s.size).toBe(60);
  });
});
