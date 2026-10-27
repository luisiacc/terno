import { expect, it, vi } from "vitest";
import { createGmailApiProvider, toBase64url } from "./gmail-api";
import { IncomingReads } from "./incoming";
import type { ProviderContext, SyncSink } from "./types";

it.each(["reset", "close", "caller"] as const)("cancels queued raw preparation on %s without dispatch or network deadlines", async (action) => {
  const incoming = new IncomingReads(1), ctl = new AbortController();
  const release = await incoming.acquire(99, ctl.signal);
  const sinkAbort = new AbortController();
  let entered!: () => void, finished = false, downloads = 0;
  const queued = new Promise<void>((resolve) => { entered = resolve; });
  const acquire = incoming.acquire.bind(incoming);
  const spy = vi.spyOn(incoming, "acquire").mockImplementation((...args) => { const waiting = acquire(...args); entered(); return waiting; });
  const checkpoints: unknown[] = [];
  const raw = toBase64url(new TextEncoder().encode("From: sender@example.test\r\nSubject: Synthetic\r\n\r\nExact body"));
  const ctx = {
    account: { id: 1 }, config: {}, incoming,
    store: { messageByProviderId: async () => null, syncedMessages: async () => [], pendingAttachmentBodies: async () => [] },
    loadCursor: async () => null, saveCursor: async (cursor: unknown) => { checkpoints.push(cursor); },
    fetch: async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/profile")) return Response.json({ historyId: "10" });
      if (url.pathname.endsWith("/messages")) return Response.json({ messages: [{ id: "mail" }] });
      downloads++; return Response.json({ id: "mail", threadId: "thread", raw });
    },
  } as unknown as ProviderContext;
  const sink: SyncSink = {
    signal: sinkAbort.signal, windowStart: 0,
    async ingest() {}, async updateFlags() {}, async removeMessages() {}, async setBody() {}, async setSyncState() {}, async pendingMessageIds() { return new Set(); },
  };
  const provider = createGmailApiProvider(ctx, { tokens: { get: async () => "synthetic", invalidate() {} }, buildRaw: async () => new Uint8Array() });
  const result = provider.sync(sink).then(() => { finished = true; return undefined; }, (error: unknown) => { finished = true; return error; });
  try {
    await queued;
    vi.useFakeTimers();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(61000);
    expect(finished).toBe(false);
    if (action === "caller") sinkAbort.abort();
    else if (action === "close") await provider.close();
    else provider.reset!();
    const error = await result;
    if (action === "caller") expect(error).toBe(sinkAbort.signal.reason);
    else expect(error).toMatchObject({ name: "ProviderError", retryable: true, ambiguous: false, network: false });
    expect(downloads).toBe(0);
    expect(checkpoints).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
    release(); spy.mockRestore();
    (await incoming.acquire(2, new AbortController().signal))();
    if (action === "reset") {
      await provider.sync(sink);
      expect(downloads).toBe(1);
      expect(checkpoints).toEqual([{ historyId: "10" }]);
    }
  } finally {
    vi.useRealTimers(); sinkAbort.abort(); release(); incoming.close(); spy.mockRestore();
    await result; await provider.close();
  }
});
