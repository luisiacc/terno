import { describe, expect, it, vi } from "vitest";
import { measure, measureAsync } from "./perf";

describe("measure", () => {
  it("measures a batch over budget again with the next indexes: a write isn't repeated as a no-op", () => {
    const seen: number[] = [];
    // a clock of its own, each call a little faster than the last, so the best batch is the last (on the real clock a
    // loaded machine decided which)
    let now = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    try {
      // a budget nothing meets: three batches
      const s = measure("x", -1, (i) => ((now += 100 - i), seen.push(i)), 4, 2);
      expect(seen).toEqual([0, 1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
      expect(s.note).toBe("batch 3");
    } finally {
      clock.mockRestore();
    }
  });

  it("stops at the first batch within budget", async () => {
    const seen: number[] = [];
    await measureAsync("x", 1_000, async (i) => void seen.push(i), 4, 0);
    expect(seen).toEqual([0, 1, 2, 3]);
  });
});
