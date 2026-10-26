import { expect, it } from "vitest";
import { BUDGET_MULTIPLIER } from "../../db/src/test/perf";
import { watchLoop } from "../../db/src/test/timing";
import { createGmailApiProvider } from "./gmail-api";
import { ProviderError, type ProviderContext, type SyncSink } from "./types";

it.each([25, 35])("validates six %i MiB raw responses within the backend slice budget", async (mib) => {
  // A bad final byte exercises the complete validation pass without including MIME decoding/parsing.
  const source = (() => {
    const bytes = Buffer.alloc(mib * 1024 * 1024, 65);
    bytes[bytes.length - 1] = 33;
    return bytes.toString("ascii");
  })();
  globalThis.gc?.();
  const ids = Array.from({ length: 6 }, (_, i) => `m${i}`);
  const budget = 15 * BUDGET_MULTIPLIER;
  let monitor: ReturnType<typeof watchLoop> | undefined;
  let downloaded = 0;
  let checkpoints = 0;
  let effects = 0;
  const ctx = {
    account: { id: 1 }, config: {},
    store: { messageByProviderId: async () => null, syncedMessages: async () => [] },
    loadCursor: async () => null, saveCursor: async () => { checkpoints++; },
    fetch: async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/profile")) return Response.json({ historyId: "10" });
      if (url.pathname.endsWith("/messages")) return Response.json({ messages: ids.map((id) => ({ id })) });
      const id = url.pathname.split("/").at(-1)!;
      if (!ids.includes(id)) throw new Error("unexpected resource");
      const response = new Response();
      Object.defineProperty(response, "json", { value: async () => {
        monitor ??= watchLoop(budget);
        downloaded++;
        return { id, threadId: id, raw: source };
      } });
      return response;
    },
  } as unknown as ProviderContext;
  const effect = async () => { effects++; };
  const sink: SyncSink = {
    ingest: effect, updateFlags: effect, removeMessages: effect, setBody: effect, setSyncState: effect,
    pendingMessageIds: async () => new Set(), windowStart: 0, signal: new AbortController().signal,
  };
  const provider = createGmailApiProvider(ctx, { tokens: { get: async () => "synthetic", invalidate() {} }, buildRaw: async () => new Uint8Array() });
  let error: unknown;
  try {
    error = await provider.sync(sink).catch((failure: unknown) => failure);
  } finally {
    const timing = monitor?.stop();
    await provider.close();
    expect(timing?.stall, `raw validation stall (${mib} MiB, six workers): ${JSON.stringify(timing)}`).toBeLessThanOrEqual(budget);
  }
  expect(error).toBeInstanceOf(ProviderError);
  expect(downloaded).toBe(6);
  expect(checkpoints).toBe(0);
  expect(effects).toBe(0);
});
