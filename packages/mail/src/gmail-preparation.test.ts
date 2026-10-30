import { completedGmailCursors } from "./test/gmail-cursor.fixture";
import { getEventListeners } from "node:events";
import { expect, it } from "vitest";
import { createGmailApiProvider, toBase64url } from "./gmail-api";
import { IncomingReads } from "./incoming";
import type { ProviderContext, SyncSink } from "./types";

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

it.each(["token failure", "raw failure", "401 retry", "reset", "caller"] as const)("settles token preparation on %s without borrowing later dispatch capacity", async (action) => {
  const failed = ["token failure", "raw failure", "401 retry"].includes(action);
  const capacity = failed ? 2 : 1;
  const incoming = new IncomingReads(capacity), caller = new AbortController();
  const token = gate(), bad = gate(), entered = gate();
  const original = new Error("Synthetic first token failure");
  const ids = failed ? ["bad", "later", "queued"] : ["later"];
  const raw = toBase64url(new TextEncoder().encode("From: sender@example.test\r\nSubject: Synthetic\r\n\r\nExact body"));
  let tokens = 0, laterRequests = 0, finished = false;
  const downloads: string[] = [], checkpoints: unknown[] = [];
  const signals = new Set<AbortSignal>([caller.signal]);
  const ctx = {
    account: { id: 1 }, config: {}, incoming: { acquire: (...args: Parameters<IncomingReads["acquire"]>) => {
      signals.add(args[1]); if (args[2]) signals.add(args[2]);
      return incoming.acquire(...args);
    } },
    store: { messageByProviderId: async () => null, syncedMessages: async () => [], syncedMessagePage: async () => ({ items: [] }), pendingAttachmentBodies: async () => [] },
    loadCursor: async () => null, saveCursor: async (cursor: unknown) => { checkpoints.push(cursor); },
    fetch: async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/profile")) return Response.json({ historyId: "10" });
      if (url.pathname.endsWith("/history")) return Response.json({ historyId: "10" });
      if (url.pathname.endsWith("/messages")) return Response.json({ messages: ids.map((id) => ({ id })) });
      const id = url.pathname.split("/").at(-1)!;
      downloads.push(id);
      if (id === "bad") { await bad.promise; return Response.json({ id: "wrong", threadId: id, raw }); }
      if (id === "later" && action === "401 retry" && ++laterRequests === 1) return Response.json({}, { status: 401 });
      return Response.json({ id, threadId: id, raw });
    },
  } as unknown as ProviderContext;
  const sink: SyncSink = {
    signal: caller.signal, windowStart: 0,
    async ingest() {}, async updateFlags() {}, async removeMessages() {}, async setBody() {}, async setSyncState() {}, async pendingMessageIds() { return new Set(); },
  };
  const provider = createGmailApiProvider(ctx, {
    tokens: {
      async get() {
        const n = ++tokens;
        if (action === "token failure" && n === 3) { await bad.promise; throw original; }
        const blockAt = action === "401 retry" ? 5 : failed ? 4 : 3;
        if (n === blockAt) { entered.release(); await token.promise; }
        return "synthetic";
      },
      invalidate() {},
    },
    buildRaw: async () => new Uint8Array(),
  });
  const result = provider.sync(sink).then(() => { finished = true; return undefined; }, (error: unknown) => { finished = true; return error; });
  try {
    await entered.promise;
    if (failed) bad.release();
    else if (action === "reset") provider.reset!();
    else caller.abort();
    await turn(); await turn();
    expect(finished).toBe(true);
    const error = await result;
    if (action === "token failure") expect(error).toBe(original);
    else if (action === "caller") expect(error).toBe(caller.signal.reason);
    else expect(error).toMatchObject({ name: "ProviderError", retryable: true });
    const expected = action === "raw failure" ? ["bad"] : action === "401 retry" ? ["bad", "later"] : [];
    expect(downloads).toEqual(expected);
    expect(completedGmailCursors(checkpoints)).toEqual([]);
    for (const signal of signals) expect(getEventListeners(signal, "abort")).toEqual([]);
    const leases = await Promise.all(Array.from({ length: capacity }, () => incoming.acquire(9, new AbortController().signal)));
    for (const release of leases) release();
    token.release();
    await turn(); await turn();
    expect(downloads).toEqual(expected);
    if (action === "reset") {
      await provider.sync(sink);
      expect(downloads).toEqual(["later"]);
      expect(completedGmailCursors(checkpoints)).toEqual([{ historyId: "10" }]);
    }
  } finally {
    bad.release(); token.release(); caller.abort();
    await result; incoming.close(); await provider.close();
  }
});

it("lets an already-dispatched read settle while canceling later preparation", async () => {
  const incoming = new IncomingReads(2), bad = gate(), good = gate();
  const raw = toBase64url(new TextEncoder().encode("From: sender@example.test\r\nSubject: Synthetic\r\n\r\nBody"));
  const downloads: string[] = [], checkpoints: unknown[] = [];
  let activeSignal: AbortSignal | null | undefined;
  const ctx = {
    account: { id: 1 }, config: {}, incoming,
    store: { messageByProviderId: async () => null, syncedMessages: async () => [], syncedMessagePage: async () => ({ items: [] }), pendingAttachmentBodies: async () => [] },
    loadCursor: async () => null, saveCursor: async (cursor: unknown) => { checkpoints.push(cursor); },
    fetch: async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/profile")) return Response.json({ historyId: "10" });
      if (url.pathname.endsWith("/history")) return Response.json({ historyId: "10" });
      if (url.pathname.endsWith("/messages")) return Response.json({ messages: ["bad", "active", "queued"].map((id) => ({ id })) });
      const id = url.pathname.split("/").at(-1)!;
      downloads.push(id);
      if (id === "bad") { await bad.promise; return Response.json({ id: "wrong", threadId: id, raw }); }
      activeSignal = init?.signal; await good.promise;
      return Response.json({ id, threadId: id, raw });
    },
  } as unknown as ProviderContext;
  const sink: SyncSink = {
    signal: new AbortController().signal, windowStart: 0,
    async ingest() {}, async updateFlags() {}, async removeMessages() {}, async setBody() {}, async setSyncState() {}, async pendingMessageIds() { return new Set(); },
  };
  const provider = createGmailApiProvider(ctx, { tokens: { get: async () => "synthetic", invalidate() {} }, buildRaw: async () => new Uint8Array() });
  const result = provider.sync(sink).catch((error: unknown) => error);
  try {
    await expect.poll(() => downloads).toEqual(["bad", "active"]);
    bad.release(); await turn(); await turn();
    expect(activeSignal?.aborted).toBe(false);
    good.release();
    expect(await result).toMatchObject({ name: "ProviderError", retryable: true });
    expect(downloads).toEqual(["bad", "active"]);
    expect(completedGmailCursors(checkpoints)).toEqual([]);
    expect(getEventListeners(sink.signal, "abort")).toEqual([]);
  } finally { bad.release(); good.release(); await result; incoming.close(); await provider.close(); }
});
