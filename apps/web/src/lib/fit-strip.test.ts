/**
 * What fits on a strip's one row (Lumen's filter chips), and what goes behind More.
 */
import { describe, expect, it } from "vitest";
import { fitStrip } from "./fit-strip";

describe("what fits on the row", () => {
  const base = { pinned: 200, more: 60, gap: 4 };
  it("everything, when it fits (no More)", () => {
    expect(fitStrip({ ...base, widths: [80, 80, 80], available: 1000, selected: -1 })).toEqual({ visible: [0, 1, 2], overflow: [] });
  });
  it("in order while they fit, the rest behind More (whose width is reserved)", () => {
    // room: 600 - 200 - 60 - 4 = 336 → four of 84 (80 + gap) exactly fit
    expect(fitStrip({ ...base, widths: [80, 80, 80, 80, 80, 80], available: 600, selected: -1 })).toEqual({ visible: [0, 1, 2, 3], overflow: [4, 5] });
  });
  it("the selected one is never hidden: it takes the end of the row", () => {
    const r = fitStrip({ ...base, widths: [80, 80, 80, 80, 80, 80], available: 600, selected: 5 });
    expect(r.visible).toEqual([0, 1, 2, 5]);
    expect(r.overflow).toEqual([3, 4]);
  });
  it("a wide selected one displaces as many as it needs", () => {
    const r = fitStrip({ ...base, widths: [80, 80, 80, 80, 240], available: 600, selected: 4 });
    expect(r.visible).toEqual([0, 4]);
    expect(r.overflow).toEqual([1, 2, 3]);
  });
  it("room for nothing but the pinned ones: all behind More, the selected one still shown", () => {
    expect(fitStrip({ ...base, widths: [80, 80], available: 250, selected: -1 })).toEqual({ visible: [], overflow: [0, 1] });
    expect(fitStrip({ ...base, widths: [80, 80], available: 250, selected: 1 }).visible).toEqual([1]);
  });
});
