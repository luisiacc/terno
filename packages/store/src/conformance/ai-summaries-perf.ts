import { generateDataset } from "@terno/mock-data";
import { expect } from "vitest";
import type { MailStore } from "../mail-store";
import { msg } from "./fixtures";

/**
 * Plan 132 at 50k+ threads, the same workload on both stores: 2,000 live messages arriving in slices of 200 with
 * summaries on, against the same slices with them off, and what the worker and the reader read while hundreds wait.
 * What marking costs follows the slice, never the mailbox; the reads follow one thread or one page.
 */
export async function measureAiSummaries(store: MailStore, o: { now: number; budget: number; log: (line: string) => void }): Promise<void> {
  const seeded = await store.dev.seed(generateDataset({ threads: 50_000, accounts: 4, seed: 132, now: o.now, bodyScale: 0.05 }), { now: o.now, categorizeRate: 0 });
  expect(seeded.threadCount).toBeGreaterThanOrEqual(50_000);
  const accountId = seeded.accountIds[0]!;
  const slices = async (newMail: { summary: boolean } | undefined, salt: number) => {
    const times: number[] = [];
    for (let slice = 0; slice < 10; slice++) {
      const at = o.now + 1000 + salt + slice;
      const batch = Array.from({ length: 200 }, (_, i) => msg({ accountId, subject: `Hola ${salt}-${slice}-${i}`, date: at - 60_000 }));
      const start = performance.now();
      await store.sync.ingest(batch, { applyFilters: true, now: at, classifier: null, ...(newMail ? { newMail } : {}) });
      times.push(performance.now() - start);
    }
    return times;
  };
  const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.95) - 1]!;
  const off = await slices(undefined, 0);
  const on = await slices({ summary: true }, 100);
  expect(await store.aiSummaries.pendingCount()).toBe(2000);

  const pending = await store.aiSummaries.pending(null, 50);
  const reads: number[] = [];
  for (let i = 0; i < 40; i++) {
    const threadId = pending[i % pending.length]!.threadId;
    const start = performance.now();
    await store.aiSummaries.get(threadId);
    await store.aiSummaries.sources(threadId);
    await store.aiSummaries.pending(null, 50);
    reads.push(performance.now() - start);
  }
  o.log(`ingest(200 live) p95 off ${p95(off).toFixed(2)} ms, on ${p95(on).toFixed(2)} ms · the worker's and reader's reads p95 ${p95(reads).toFixed(2)} ms (2,000 waiting)`);
  // marking is one indexed write per message, inside the slice: a fraction of what the slice already costs
  expect(p95(on)).toBeLessThanOrEqual(p95(off) * 1.5 + 15 * o.budget);
  expect(p95(reads)).toBeLessThanOrEqual(10 * o.budget);
}
