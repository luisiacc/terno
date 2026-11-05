/** Splitting off quoted history stays linear on hostile text (timed alone: the unit stage's load isn't this code's). */
import { expect, it } from "vitest";
import { splitTextQuote } from "./quote";

it("stays linear on hostile input: thousands of rules, blank lines and quotes", () => {
  const time = (n: number) => {
    const text = `${"________\n\n".repeat(n)}Hola\n${"> x\n\n".repeat(n)}`;
    const t0 = performance.now();
    for (let i = 0; i < 3; i++) splitTextQuote(text);
    return (performance.now() - t0) / 3;
  };
  time(2000);
  const small = time(10_000);
  const big = time(40_000);
  // 160k lines: tens of ms, and 4× the input costs ~4× the time (quadratic would be ~16×)
  expect(big).toBeLessThan(150);
  expect(big / Math.max(small, 1)).toBeLessThan(8);
});
