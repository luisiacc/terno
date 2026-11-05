import { IncomingReads } from "./incoming";
import { expect, it } from "vitest";
import { BUDGET_MULTIPLIER } from "../../db/src/test/perf";
import { threadCpuMs } from "../../db/src/test/timing";
import { createGmailApiProvider, toBase64url } from "./gmail-api";
import type { ProviderContext, SyncSink } from "./types";

it("keeps small-message processing within its qualified CPU and transaction budgets, by the message", async () => {
  // a page's and a transaction's bound, and 50 µs a message (they don't follow the count): 400 transactions
  const count = 20_000;
  const raw = toBase64url(new TextEncoder().encode("From: sender@example.test\r\nSubject: Synthetic\r\nContent-Type: text/plain\r\n\r\nOrdinary small mail"));
  const checkpoint = { historyId: "9007199254740995" };
  let requests = 0, historyReads = 0, labelReads = 0, ingested = 0, transactions = 0, cursorWrites = 0, maxCursorBytes = 0, saved: unknown;
  const ids = new Set<string>();
  new Response();
  const ctx = {
    incoming: new IncomingReads(),
    account: { id: 1 }, config: {},
    store: { messageByProviderId: async () => null, syncedMessages: async () => [], syncedMessagePage: async () => ({ items: [] }), pendingAttachmentBodies: async () => [] },
    loadCursor: async () => null, saveCursor: async (value: unknown) => { saved = value; cursorWrites++; maxCursorBytes = Math.max(maxCursorBytes, JSON.stringify(value).length); },
    fetch: async (input: string | URL) => {
      requests++;
      const url = new URL(String(input));
      if (url.pathname.endsWith("/profile")) return Response.json(checkpoint);
      if (url.pathname.endsWith("/history")) { historyReads++; return Response.json(checkpoint); }
      // a long first sync reads the labels once before its downloads (2026-11)
      if (url.pathname.endsWith("/labels")) { labelReads++; return Response.json({ labels: [] }); }
      if (url.pathname.endsWith("/messages")) {
        const start = Number(url.searchParams.get("pageToken") ?? 0);
        const end = Math.min(count, start + 500);
        return Response.json({ messages: Array.from({ length: end - start }, (_, i) => ({ id: `m${start + i}` })), ...(end < count ? { nextPageToken: String(end) } : {}) });
      }
      const id = url.pathname.split("/").at(-1)!;
      return Response.json({ id, threadId: id, raw });
    },
  } as unknown as ProviderContext;
  const sink: SyncSink = {
    signal: new AbortController().signal, windowStart: 0,
    async ingest(batch) {
      expect(batch).toHaveLength(50);
      transactions++; ingested += batch.length;
      for (const message of batch) ids.add(message.providerMsgId!);
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
    async updateFlags() {}, async removeMessages() {}, async setBody() {}, async setSyncState() {}, async pendingMessageIds() { return new Set(); },
  };
  const p = createGmailApiProvider(ctx, { tokens: { get: async () => "synthetic", invalidate() {} }, buildRaw: async () => new Uint8Array() });
  globalThis.gc?.();
  const cpu = threadCpuMs();
  try { await p.sync(sink); }
  finally { await p.close(); }
  const elapsedCpu = threadCpuMs() - cpu;
  expect(elapsedCpu, `${count} provider/synthetic-sink CPU: ${elapsedCpu.toFixed(2)} ms`).toBeLessThanOrEqual((count / 20) * BUDGET_MULTIPLIER);
  expect(historyReads).toBe(1);
  expect(labelReads).toBe(1);
  expect(requests).toBe(count + Math.ceil(count / 500) + 1 + historyReads + labelReads);
  expect(ingested).toBe(count);
  expect(ids.size).toBe(count);
  expect(transactions).toBe(count / 50);
  expect(saved).toEqual(checkpoint);
  expect(cursorWrites).toBe(Math.ceil(count / 500) + 3);
  expect(maxCursorBytes).toBeLessThan(512);
});

it("bounds cached refresh pages, effects and durable scalar checkpoints, by the message", async () => {
  const count = 20_000, baseline = "9007199254740995";
  let reads = 0, requests = 0, effects = 0, writes = 0, maxBytes = 0, saved: unknown;
  const ctx = {
    incoming: new IncomingReads(), account: { id: 1, email: "synthetic@example.test" }, config: {},
    store: {
      messageByProviderId: async () => null,
      syncedMessages: async () => { throw new Error("unbounded cached read"); },
      syncedMessagePage: async (after?: string) => {
        reads++;
        const start = after ? Number(after.slice(1)) + 1 : 0;
        const items = Array.from({ length: Math.min(50, count - start) }, (_, i) => ({ id: start + i + 1, providerMsgId: `m${String(start + i).padStart(5, "0")}` }));
        return { items, next: items.at(-1)?.providerMsgId };
      },
      pendingAttachmentBodies: async () => [],
    },
    // the backend's cooperative turn (core.ts: the Node platform's setImmediate), not a timer: what each control read yields to (7de175c2)
    yield: () => new Promise<void>((resolve) => setImmediate(resolve)),
    loadCursor: async () => null,
    saveCursor: async (value: unknown) => { saved = value; writes++; maxBytes = Math.max(maxBytes, JSON.stringify(value).length); },
    fetch: async (input: string | URL) => {
      requests++; const url = new URL(String(input));
      if (url.pathname.endsWith("/profile") || url.pathname.endsWith("/history")) return Response.json({ historyId: baseline });
      if (url.pathname.endsWith("/messages")) return Response.json({ messages: [] });
      // a long flag refresh reads the labels once first (2026-11)
      if (url.pathname.endsWith("/labels")) return Response.json({ labels: [] });
      expect(url.searchParams.get("format")).toBe("minimal");
      return Response.json({ id: url.pathname.split("/").at(-1), labelIds: ["INBOX"] });
    },
  } as unknown as ProviderContext;
  const sink: SyncSink = {
    signal: new AbortController().signal, windowStart: 0,
    async ingest() { throw new Error("unexpected ingestion"); },
    async updateFlags(batch) { expect(batch).toHaveLength(50); effects++; await new Promise<void>((resolve) => setImmediate(resolve)); },
    async removeMessages() { throw new Error("unexpected deletion"); },
    async setBody() {}, async setSyncState() {}, async pendingMessageIds() { return new Set(); },
  };
  const provider = createGmailApiProvider(ctx, { tokens: { get: async () => "synthetic", invalidate() {} }, buildRaw: async () => new Uint8Array() });
  const start = threadCpuMs();
  try { await provider.sync(sink); } finally { await provider.close(); }
  const cpu = threadCpuMs() - start;
  expect(cpu, `${count} cached refresh CPU ${cpu.toFixed(2)}ms`).toBeLessThanOrEqual((count / 20) * BUDGET_MULTIPLIER);
  expect(reads).toBe(count / 50 + 1); expect(requests).toBe(count + 4); expect(effects).toBe(count / 50);
  expect(writes).toBe(count / 50 + 4); expect(maxBytes).toBeLessThan(512); expect(saved).toEqual({ historyId: baseline });
});
