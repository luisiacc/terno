import "fake-indexeddb/auto";
import { expect, it } from "vitest";
import { generateDataset } from "@terno/mock-data";
import { IdbMailStore } from "./store";

it("idle IMAP pending lookups stay below 5 ms over 50,000 completed IndexedDB rows", async () => {
  const store = await IdbMailStore.open({ name: "capture-pending-perf-50k", factory: indexedDB, instantSearch: false, platform: { uuid: () => crypto.randomUUID(), yield: () => Promise.resolve() } });
  try {
    const data = generateDataset({ threads: 30000, accounts: 1, seed: 7, now: 0, bodyScale: 0.01 });
    for (const m of data.messages) { m.attachments = []; m.hasAttachments = false; m.bodyState = "full"; }
    const { accountIds, messageCount } = await store.dev.seed(data, { now: 0, categorizeRate: 0 });
    expect(messageCount).toBeGreaterThanOrEqual(50000);
    const times: number[] = [];
    const provider = store.providerStore(accountIds[0]!);
    for (let i = 0; i < 100; i++) {
      const start = performance.now();
      expect(await provider.pendingBodies(50)).toEqual([]);
      expect(await provider.countPendingBodies()).toBe(0);
      times.push(performance.now() - start);
    }
    const p95 = times.sort((a,b) => a - b)[94]!;
    expect(p95).toBeLessThanOrEqual(5);
    (globalThis as { process?: { stderr: { write(text: string): void } } }).process?.stderr.write(`[50k IDB IMAP pending] p95 ${p95.toFixed(3)} ms\n`);
  } finally { await store.close(); }
});
