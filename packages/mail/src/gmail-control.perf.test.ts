import { expect, it } from "vitest";
import { BUDGET_MULTIPLIER } from "../../db/src/test/perf";
import { watchLoop } from "../../db/src/test/timing";
import { createGmailApiProvider } from "./gmail-api";
import type { ProviderContext } from "./types";

it.each([1, 65_536])("consumes a bounded control response in %i-byte chunks within the backend slice budget", async (chunkSize) => {
  const bytes = new TextEncoder().encode(JSON.stringify({ historyId: "9007199254740995", ignored: "x".repeat(60_000) }));
  const pieces: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) pieces.push(bytes.slice(i, i + chunkSize));
  let offset = 0, requests = 0;
  let next = 0;
  const response = new Response(new ReadableStream<Uint8Array>({ pull(controller) {
    if (offset === bytes.length) return controller.close();
    const piece = pieces[next++]!;
    controller.enqueue(piece); offset += piece.length;
  } }));
  globalThis.gc?.();
  const ctx = {
    account: { id: 1 }, store: {},
    fetch: async () => {
      requests++;
      return response;
    },
  } as unknown as ProviderContext;
  const p = createGmailApiProvider(ctx, { tokens: { get: async () => "synthetic", invalidate() {} }, buildRaw: async () => new Uint8Array() });
  const budget = 15 * BUDGET_MULTIPLIER;
  const monitor = watchLoop(budget);
  try { await p.verify(); }
  finally {
    const timing = monitor.stop();
    await p.close();
    expect(timing.stall, JSON.stringify(timing)).toBeLessThanOrEqual(budget);
  }
  expect(requests).toBe(1);
  expect(offset).toBe(bytes.length);
});
