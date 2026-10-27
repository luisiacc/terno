import { expect, it } from "vitest";
import { BUDGET_MULTIPLIER } from "../../db/src/test/perf";
import { threadCpuMs } from "../../db/src/test/timing";
import { createGmailApiProvider, toBase64url } from "./gmail-api";
import type { ProviderContext, SyncSink } from "./types";

it("keeps 50k small-message processing within its qualified CPU and transaction budgets", async () => {
  const count = 50_000;
  const raw = toBase64url(new TextEncoder().encode("From: sender@example.test\r\nSubject: Synthetic\r\nContent-Type: text/plain\r\n\r\nOrdinary small mail"));
  const checkpoint = { historyId: "9007199254740995" };
  let requests = 0, ingested = 0, transactions = 0, saved: unknown;
  const ids = new Set<string>();
  new Response();
  const ctx = {
    account: { id: 1 }, config: {},
    store: { messageByProviderId: async () => null, syncedMessages: async () => [], pendingAttachmentBodies: async () => [] },
    loadCursor: async () => null, saveCursor: async (value: unknown) => { saved = value; },
    fetch: async (input: string | URL) => {
      requests++;
      const url = new URL(String(input));
      if (url.pathname.endsWith("/profile")) return Response.json(checkpoint);
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
  expect(elapsedCpu, `50k provider/synthetic-sink CPU: ${elapsedCpu.toFixed(2)} ms`).toBeLessThanOrEqual(2500 * BUDGET_MULTIPLIER);
  expect(requests).toBe(50_101);
  expect(ingested).toBe(count);
  expect(ids.size).toBe(count);
  expect(transactions).toBe(1000);
  expect(saved).toEqual(checkpoint);
});
