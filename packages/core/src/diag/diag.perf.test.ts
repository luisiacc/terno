/**
 * Diagnostics on the hot path: a log call (schema check, entry, crumb, sink)
 * and a breadcrumb stay within a few microseconds, so instrumenting a code
 * path never shows up in the other perf gates.
 */
import { expect, it } from "vitest";
import { breadcrumb, installDiag, log } from "./diag";

declare const console: { log(...args: unknown[]): void };

function perCall(n: number, fn: (i: number) => void): number {
  for (let i = 0; i < 5000; i++) fn(i); // warm up
  let best = Infinity;
  for (let round = 0; round < 5; round++) {
    const t = performance.now();
    for (let i = 0; i < n; i++) fn(i);
    best = Math.min(best, ((performance.now() - t) * 1000) / n);
  }
  return best;
}

it("a log call costs under 5 µs, a breadcrumb under 1 µs", () => {
  let written = 0;
  installDiag({ proc: "backend", version: "1", build: "1+perf", channel: "test", sink: { write: () => void written++, capture: () => {}, mirror: () => {} } });
  const logUs = perCall(100_000, (i) => log.info("rpc.call", { method: "threads.list", durationMs: i % 50, ok: true }));
  const crumbUs = perCall(100_000, (i) => breadcrumb("nav", "nav.thread", { threadId: i }));
  console.log(`diag: log ${logUs.toFixed(2)} µs/call, breadcrumb ${crumbUs.toFixed(2)} µs/call`);
  expect(written).toBeGreaterThan(0);
  expect(logUs).toBeLessThan(5);
  expect(crumbUs).toBeLessThan(1);
});
