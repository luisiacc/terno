import { describe, expect, it } from "vitest";
import { measure, measureAsync } from "./perf";

describe("measure", () => {
  it("measures a batch over budget again with the next indexes: a write isn't repeated as a no-op", () => {
    const seen: number[] = [];
    // a budget nothing meets: three batches
    const s = measure("x", -1, (i) => seen.push(i), 4, 2);
    expect(seen).toEqual([0, 1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(s.note).toBe("batch 3");
  });

  it("stops at the first batch within budget", async () => {
    const seen: number[] = [];
    await measureAsync("x", 1_000, async (i) => void seen.push(i), 4, 0);
    expect(seen).toEqual([0, 1, 2, 3]);
  });
});
