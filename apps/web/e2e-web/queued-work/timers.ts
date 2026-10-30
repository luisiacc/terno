import { expect, type Worker } from "@playwright/test";

type Counts = { starts: number; callbacks: number; clears: number; shortStarts: number; shortCallbacks: number; pending: number; shortPending: number; intervals: number[] };
export async function timers(worker: Worker): Promise<Counts> {
  return worker.evaluate(() => (globalThis as typeof globalThis & { __w11Timers: () => Counts }).__w11Timers());
}
export function expectIdle(before: Counts, after: Counts): void {
  expect(after.shortStarts - before.shortStarts).toBeLessThanOrEqual(2);
  expect(after.shortCallbacks - before.shortCallbacks).toBeLessThanOrEqual(2);
  expect(after.starts - before.starts).toBeLessThanOrEqual(3);
  expect(after.callbacks - before.callbacks).toBeLessThanOrEqual(3);
  expect(after.shortPending).toBeLessThanOrEqual(1);
  expect(after.pending).toBeLessThanOrEqual(before.pending + 2);
}
