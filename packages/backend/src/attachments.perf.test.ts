import { attachmentMessageBudgetAsync } from "@terno/core";
import { expect, it } from "vitest";

it("exact MIME preflight yields between bounded UTF-8 slices, including a large ASCII body", async () => {
  let cpu = process.threadCpuUsage();
  let wall = performance.now();
  let maxCpu = 0; let maxWall = 0; let slices = 0;
  const yieldTo = async () => {
    const used = process.threadCpuUsage(cpu);
    maxCpu = Math.max(maxCpu, (used.user + used.system) / 1000);
    maxWall = Math.max(maxWall, performance.now() - wall);
    slices++;
    await new Promise<void>((resolve) => setImmediate(resolve));
    cpu = process.threadCpuUsage(); wall = performance.now();
  };
  const ascii = "a".repeat(7 * 1024 * 1024);
  expect(await attachmentMessageBudgetAsync(ascii, undefined, [], yieldTo)).toBe(true);
  cpu = process.threadCpuUsage(); wall = performance.now();
  expect(await attachmentMessageBudgetAsync("界".repeat(7 * 1024 * 1024), undefined, [], yieldTo)).toBe(false);
  expect(slices).toBeGreaterThan(800);
  // CPU bounds the work itself; wall time also reports scheduling on a shared machine.
  expect(maxCpu).toBeLessThanOrEqual(15);
  process.stderr.write(`[attachment preflight] ${slices} slices, max CPU ${maxCpu.toFixed(2)} ms, max wall ${maxWall.toFixed(2)} ms\n`);
});
