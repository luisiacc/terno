import { describe, expect, it } from "vitest";
import { orderByDate } from "./actions";

/** Plan 143: a preview's rows go newest first in one turn, so that turn has to stay inside the slicer's budget at the cap. */
describe("a preview's order", () => {
  it("100,000 rows order within a turn's budget", () => {
    const ids = Array.from({ length: 100_000 }, (_, i) => i + 1);
    const stamps = new Map(ids.map((id) => [id, { lastDate: Math.floor(Math.random() * 1e12), messageCount: 1 }]));
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const started = performance.now();
      const out = orderByDate(ids, stamps);
      times.push(performance.now() - started);
      expect(out).toHaveLength(ids.length);
    }
    const best = Math.min(...times);
    process.stderr.write(`order 100k: ${best.toFixed(1)} ms\n`);
    expect(best).toBeLessThanOrEqual(120);
  });
});
