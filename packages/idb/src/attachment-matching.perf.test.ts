import { expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { IdbMailStore } from "./store";
import { ingest, msg, withAccounts } from "@terno/store/conformance";

const host = globalThis as unknown as { process: { threadCpuUsage(previous?: { user: number; system: number }): { user: number; system: number }; stderr: { write(text: string): void } } };

it("slices IDB metadata matching before allocating on a 10,000-unavailable-part ingestion retry", async () => {
  let slices = 0, maxCpu = 0, cpu = host.process.threadCpuUsage();
  const store = await IdbMailStore.open({ name: crypto.randomUUID(), factory: indexedDB, instantSearch: false, platform: { uuid: () => crypto.randomUUID(), yield: async () => {
    const used = host.process.threadCpuUsage(cpu); maxCpu = Math.max(maxCpu, (used.user + used.system) / 1000);
    slices++; await new Promise<void>((r) => setTimeout(r, 0)); cpu = host.process.threadCpuUsage();
  } } });
  try {
    const [accountId] = await withAccounts(store, 1);
    const attachments = Array.from({ length: 10000 }, (_, i) => ({ filename: `missing-${i}`, mime: "text/plain", size: 0 }));
    await ingest(store, [msg({ accountId: accountId!, providerMsgId: "many-parts", attachments })]);
    const create = vi.spyOn(store.attachments, "create");
    let beforeCreate = 0;
    create.mockImplementationOnce(async () => { beforeCreate = slices; throw new Error("stop before replacement"); });
    slices = 0; maxCpu = 0; cpu = host.process.threadCpuUsage();
    await expect(ingest(store, [msg({ accountId: accountId!, providerMsgId: "many-parts", attachments: attachments.map((p) => ({ ...p, bytes: new Uint8Array() })) })])).rejects.toThrow("stop before replacement");
    expect(beforeCreate).toBeGreaterThan(100);
    expect(maxCpu).toBeLessThanOrEqual(15);
    host.process.stderr.write(`[10k attachment matching] ${slices} slices, max CPU ${maxCpu.toFixed(2)} ms\n`);
  } finally { await store.close(); }
});
