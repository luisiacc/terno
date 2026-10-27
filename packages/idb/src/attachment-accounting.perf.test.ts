import "fake-indexeddb/auto";
import { expect, it } from "vitest";
import { IdbMailStore } from "./store";
import { openIdb } from "./schema";
import { withAccounts } from "@terno/store/conformance";

const host = globalThis as unknown as { process: { threadCpuUsage(previous?: { user: number; system: number }): { user: number; system: number }; stderr: { write(text: string): void } } };

it("creates and reclaims assets within 15 ms CPU with 100,000 pinned IDB reservations", async () => {
  const options = { name: crypto.randomUUID(), factory: indexedDB, instantSearch: false, platform: { uuid: () => crypto.randomUUID(), yield: () => Promise.resolve() } };
  let store = await IdbMailStore.open(options);
  try {
    const [accountId] = await withAccounts(store, 1);
    const draft = (await store.drafts.save({ accountId: accountId!, to: [], cc: [], subject: "pins", bodyText: "" }, 0))!;
    await store.close();
    const raw = await openIdb(indexedDB, options.name);
    const tx = raw.transaction(["attachment_assets", "attachment_links"], "readwrite");
    for (let i = 0; i < 100000; i++) {
      tx.objectStore("attachment_assets").put({ id: `pin-${i}`, account_id: accountId, filename: "empty", mime: "text/plain", size: 0, received: 0, chunks: 0, complete: 1, created_at: 0 }, `pin-${i}`);
      tx.objectStore("attachment_links").put({ id: `link-${i}`, asset_id: `pin-${i}`, draft_id: draft.id }, `link-${i}`);
    }
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); }); raw.close();
    store = await IdbMailStore.open(options);
    await store.attachments.current(accountId!, { id: -1 });
    let maxCpu = 0, maxWall = 0;
    for (let i = 0; i < 20; i++) {
      const cpu = host.process.threadCpuUsage(), wall = performance.now();
      await store.attachments.create({ accountId: accountId!, filename: "new", mime: "text/plain", size: 0, now: i % 2 ? 172800000 : 0 });
      const used = host.process.threadCpuUsage(cpu); maxCpu = Math.max(maxCpu, (used.user + used.system) / 1000); maxWall = Math.max(maxWall, performance.now() - wall);
    }
    host.process.stderr.write(`[100k IDB asset create/cleanup] max CPU ${maxCpu.toFixed(2)} ms, wall ${maxWall.toFixed(2)} ms\n`);
    expect(maxCpu).toBeLessThanOrEqual(15);
  } finally { await store.close(); }
});

it("public create reclaims 252 MiB of cold IDB orphan chunks with task turns and at most 15 ms CPU per slice", async () => {
  const options = { name: crypto.randomUUID(), factory: indexedDB, instantSearch: false, platform: { uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((r) => setTimeout(r, 0)) } };
  let store = await IdbMailStore.open(options);
  try {
    const [accountId] = await withAccounts(store, 1);
    await store.close();
    const raw = await openIdb(indexedDB, options.name);
    const size = 18 * 1024 * 1024, width = 48 * 1024, data = btoa(String.fromCharCode(...new Uint8Array(width).fill(90)));
    const tx = raw.transaction(["attachment_assets", "attachment_chunks", "attachment_bytes"], "readwrite");
    for (let a = 0; a < 14; a++) {
      const id = `orphan-${a}`;
      tx.objectStore("attachment_assets").put({ id, account_id: accountId, filename: "large.bin", mime: "application/octet-stream", size, received: size, chunks: size / width, complete: 1, created_at: 0, orphan_grace_started_at: 0 }, id);
      for (let i = 0; i < size / width; i++) {
        const key = `${id}:${i}`;
        tx.objectStore("attachment_chunks").put({ id: key, asset_id: id, position: i, size: width }, key);
        tx.objectStore("attachment_bytes").put({ chunk_id: key, data_base64: data }, key);
      }
    }
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); }); raw.close();
    store = await IdbMailStore.open(options); await store.whenLoaded();
    let previous = host.process.threadCpuUsage(), maxCpu = 0, turns = 0;
    const record = () => { const cpu = host.process.threadCpuUsage(previous); maxCpu = Math.max(maxCpu, (cpu.user + cpu.system) / 1000); previous = host.process.threadCpuUsage(); };
    const heartbeat = () => { record(); turns++; timer = setTimeout(heartbeat, 0); };
    let timer = setTimeout(heartbeat, 0);
    try { await store.attachments.create({ accountId: accountId!, filename: "next", mime: "text/plain", size: 0, now: 172800000 }); record(); }
    finally { clearTimeout(timer); }
    host.process.stderr.write(`[252MiB IDB cleanup] ${turns} turns; maxCPU ${maxCpu.toFixed(2)} ms\n`);
    expect(maxCpu).toBeLessThanOrEqual(15);
    expect(turns).toBeGreaterThan(100);
    await store.close();
    const persisted = await openIdb(indexedDB, options.name);
    try {
      const counts = await Promise.all(["attachment_assets", "attachment_chunks", "attachment_bytes"].map((name) => new Promise<number>((resolve, reject) => {
        const request = persisted.transaction(name).objectStore(name).count(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      })));
      expect(counts).toEqual([1, 0, 0]);
    } finally { persisted.close(); }
  } finally { await store.close(); }
});
