/**
 * A quote or a forward converts in short steps (the backend yields between pieces): the longest
 * step stays under a frame's worth, for a 6 MB quote and for one 5-million-character line. Wall
 * time, so it runs in the perf project, alone; best of three (a rare OS hold on a busy machine).
 */
import { describe, expect, it } from "vitest";
import { textToHtmlChunks } from "./quote";

function longestStep(text: string): number {
  let worst = 0;
  const steps = textToHtmlChunks(text);
  for (;;) {
    const t0 = performance.now();
    const r = steps.next();
    worst = Math.max(worst, performance.now() - t0);
    if (r.done) return worst;
  }
}

describe("textToHtmlChunks timing", () => {
  it("each piece of a 2 MB quote ×3 and of a 5-million-character line takes under 25 ms", () => {
    const big = Array.from({ length: 40_000 }, (_, i) => `> línea ${i} de la cita, con algo de texto para pesar`).join("\n");
    for (const text of [big.repeat(3), "x ".repeat(2_500_000)]) {
      const best = Math.min(longestStep(text), longestStep(text), longestStep(text));
      expect(best).toBeLessThan(25);
    }
  });
});
