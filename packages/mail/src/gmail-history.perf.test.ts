import { expect, it } from "vitest";
import { BUDGET_MULTIPLIER } from "../../db/src/test/perf";
import { watchLoop } from "../../db/src/test/timing";
import { createGmailApiProvider } from "./gmail-api";
import type { ProviderContext, SyncSink } from "./types";

it("keeps maximal admitted history decoding and expansion within the control slice budget", async () => {
  const history = [{ labelsRemoved: Array.from({ length: 2000 }, (_, i) => ({ message: { id: `m${i}` } })) }];
  const body = JSON.stringify({ historyId: "11", history, ignored: "x".repeat(190_000) });
  expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(256 * 1024);
  const response = new Response(body);
  let lookups = 0, saved: unknown;
  const ctx = { account: { id: 1 }, config: {}, store: {
    messageByProviderId: async () => { lookups++; return null; }, pendingAttachmentBodies: async () => [],
  }, loadCursor: async () => ({ historyId: "10" }), saveCursor: async (value: unknown) => { saved = value; },
  fetch: async () => response } as unknown as ProviderContext;
  const noop = async () => {};
  const sink: SyncSink = { signal: new AbortController().signal, windowStart: 0, ingest: noop, updateFlags: noop,
    removeMessages: noop, setBody: noop, setSyncState: noop, pendingMessageIds: async () => new Set() };
  const provider = createGmailApiProvider(ctx, { tokens: { get: async () => "synthetic", invalidate() {} }, buildRaw: async () => new Uint8Array() });
  const budget = 15 * BUDGET_MULTIPLIER, monitor = watchLoop(budget);
  try { await provider.sync(sink); }
  finally {
    const timing = monitor.stop();
    await provider.close();
    expect(timing.stall).toBeLessThanOrEqual(budget);
  }
  expect(lookups).toBe(2000);
  expect(saved).toEqual({ historyId: "11" });
});
