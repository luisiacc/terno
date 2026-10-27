import { IncomingPipeline } from "./incoming";
import { createNodeIncomingProcessor } from "../../backend/src/incoming-worker";
import { expect, it } from "vitest";
import type { IncomingMessage } from "@terno/store";
import { createGmailApiProvider, toBase64url } from "./gmail-api";
import type { ProviderContext, SyncSink } from "./types";

function setup(count: number, text: string, consume?: (batch: IncomingMessage[]) => Promise<void>) {
  const processor = createNodeIncomingProcessor();
  const incoming = new IncomingPipeline(processor);
  const ids = Array.from({ length: count }, (_, i) => `m${i}`);
  const raw = toBase64url(new TextEncoder().encode(`From: sender@example.test\r\nSubject: Synthetic\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}`));
  const batches: IncomingMessage[][] = [];
  const checkpoints: unknown[] = [];
  const abort = new AbortController();
  let downloads = 0, firstIngestAt = 0, activeSink = 0, maxSink = 0;
  let gate: Promise<void> | undefined;
  const ctx = {
    incoming, incomingProcessor: processor,
    account: { id: 1 }, config: {},
    store: { messageByProviderId: async () => null, syncedMessages: async () => [], pendingAttachmentBodies: async () => [] },
    loadCursor: async () => null, saveCursor: async (cursor: unknown) => { checkpoints.push(cursor); },
    fetch: async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/profile")) return Response.json({ historyId: "10" });
      if (url.pathname.endsWith("/messages")) return Response.json({ messages: ids.map((id) => ({ id })) });
      downloads++;
      await gate;
      const id = url.pathname.split("/").at(-1)!;
      return Response.json({ id, threadId: id, raw });
    },
  } as unknown as ProviderContext;
  const sink: SyncSink = {
    signal: abort.signal, windowStart: 0,
    async ingest(batch) {
      firstIngestAt ||= downloads;
      activeSink++; maxSink = Math.max(maxSink, activeSink);
      try { await consume?.(batch); batches.push(batch); }
      finally { activeSink--; }
    },
    async updateFlags() {}, async removeMessages() {}, async setBody() {}, async setSyncState() {}, async pendingMessageIds() { return new Set(); },
  };
  const p = createGmailApiProvider(ctx, { tokens: { get: async () => "synthetic", invalidate() {} }, buildRaw: async () => new Uint8Array() });
  return { p, async close() { await p.close(); await processor.close(); incoming.close(); }, sync: () => p.sync(sink), abort: () => abort.abort(), batches, checkpoints, get downloads() { return downloads; }, get firstIngestAt() { return firstIngestAt; }, get maxSink() { return maxSink; }, setGate(value: Promise<void>) { gate = value; } };
}

it("flushes completed message bytes before retaining the whole count batch", async () => {
  const t = setup(20, "x".repeat(300 * 1024));
  try {
    await t.sync();
    expect(t.firstIngestAt).toBeLessThan(20);
    expect(t.batches.flatMap((batch) => batch.map((m) => m.providerMsgId)).sort()).toEqual(Array.from({ length: 20 }, (_, i) => `m${i}`).sort());
    for (const batch of t.batches) expect(batch.reduce((n, m) => n + (m.bodyText?.length ?? 0) * 2 + (m.bodyHtml?.length ?? 0) * 2, 0)).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(t.maxSink).toBe(1);
    expect(t.checkpoints).toEqual([{ historyId: "10" }]);
  } finally { await t.close(); }
});

it("keeps six small downloads concurrent and one full small-message transaction", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const t = setup(50, "ordinary small mail");
  t.setGate(blocked);
  const result = t.sync();
  try {
    await expect.poll(() => t.downloads).toBe(6);
    expect(t.batches).toEqual([]);
    release(); await result;
    expect(t.batches.map((batch) => batch.length)).toEqual([50]);
    expect(t.maxSink).toBe(1);
  } finally { release(); await result.catch(() => {}); await t.close(); }
});

it("durable sink failure settles producers without a checkpoint or concurrent staging", async () => {
  const failure = new Error("synthetic durable sink failure");
  const t = setup(20, "x".repeat(300 * 1024), async () => { throw failure; });
  try {
    await expect(t.sync()).rejects.toBe(failure);
    const settledDownloads = t.downloads;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(t.downloads).toBe(settledDownloads);
    expect(t.firstIngestAt).toBeLessThan(20);
    expect(t.maxSink).toBe(1);
    expect(t.checkpoints).toEqual([]);
    expect(t.batches).toEqual([]);
  } finally { await t.close(); }
});

it("a blocked durable flush applies backpressure and prevents checkpoint promotion", async () => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const t = setup(20, "x".repeat(300 * 1024), async () => { entered(); await blocked; });
  const work = t.sync();
  try {
    await started;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(t.downloads).toBeLessThan(20);
    expect(t.maxSink).toBe(1);
    expect(t.checkpoints).toEqual([]);
    release(); await work;
    expect(t.batches.flat()).toHaveLength(20);
    expect(t.checkpoints).toEqual([{ historyId: "10" }]);
  } finally { release(); await work.catch(() => {}); await t.close(); }
});

it.each([1, 49, 50])("cancellation during the last admitted write of %i messages finishes it without a checkpoint", async (count) => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const t = setup(count, "ordinary small mail", async () => { entered(); await blocked; });
  const result = Promise.allSettled([t.sync()]);
  try {
    await started;
    t.abort(); release();
    expect((await result)[0]).toMatchObject({ status: "rejected", reason: { name: "AbortError" } });
    expect(t.batches.flat()).toHaveLength(count);
    expect(t.checkpoints).toEqual([]);
  } finally { release(); await result; await t.close(); }
});

it.each([1, 49, 50])("reset during the last admitted write of %i messages finishes it without a checkpoint", async (count) => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const t = setup(count, "ordinary small mail", async () => { entered(); await blocked; });
  const result = Promise.allSettled([t.sync()]);
  try {
    await started;
    t.p.reset?.(); release();
    expect((await result)[0]).toMatchObject({ status: "rejected" });
    expect(t.batches.flat()).toHaveLength(count);
    expect(t.checkpoints).toEqual([]);
  } finally { release(); await result; await t.close(); }
});
