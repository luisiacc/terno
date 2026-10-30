import { expect, it } from "vitest";
import { recipientReceiptParts } from "@terno/store";

it("slices maximum recipient metadata preparation", async () => {
  const to = Array.from({ length: 1000 }, (_, i) => ({ name: "ñ".repeat(250), email: `r${i}@example.test` }));
  let previous = process.threadCpuUsage(), max = 0, turns = 0;
  const yieldTo = async () => { const usage = process.threadCpuUsage(previous); max = Math.max(max, (usage.user + usage.system) / 1000); turns++; await new Promise<void>((resolve) => setImmediate(resolve)); previous = process.threadCpuUsage(); };
  const result = await recipientReceiptParts({ to, cc: to, bcc: to }, yieldTo);
  const usage = process.threadCpuUsage(previous); max = Math.max(max, (usage.user + usage.system) / 1000);
  process.stderr.write(`[recipient metadata preparation] ${turns} slices, max CPU ${max.toFixed(2)} ms\n`);
  expect(result.count).toBe(3000); expect(turns).toBeGreaterThan(90); expect(max).toBeLessThanOrEqual(15);
});
