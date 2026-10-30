import { completedGmailCursors } from "./test/gmail-cursor.fixture";
import { afterEach, expect, it, vi } from "vitest";
import { createGmailApiProvider, toBase64url } from "./gmail-api";
import { IncomingPipeline } from "./incoming";
import { untilAborted } from "./http-body";
import { IncomingProcessingError, type IncomingProcessingResult } from "./incoming-processing";
import type { ParsedMessage } from "./mime";
import type { ProviderContext, SyncSink } from "./types";

const parsed: ParsedMessage = { rfcMessageId: null, inReplyTo: null, references: [], from: { name: "", email: "synthetic@example.test" }, replyTo: [], to: [], cc: [], bcc: [], subject: "Synthetic", date: null, listId: null, bulk: false, text: "Exact processed body", html: null, attachments: [] };
afterEach(() => { vi.useRealTimers(); });

function setup(rawResponse: () => Promise<Response>, process: (signal: AbortSignal) => Promise<IncomingProcessingResult>, promote?: (signal: AbortSignal) => Promise<() => void>) {
  const pipeline = new IncomingPipeline(), abort = new AbortController();
  const writes: unknown[] = [], checkpoints: unknown[] = [], removed: unknown[] = [];
  const ctx = {
    account: { id: 1 }, config: {}, incoming: { acquire: pipeline.acquire.bind(pipeline), promote: promote ? (_id: number, signal: AbortSignal) => promote(signal) : pipeline.promote.bind(pipeline) },
    incomingProcessor: { run: (_input: unknown, signal: AbortSignal) => process(signal) },
    store: { messageByProviderId: async () => null, syncedMessages: async () => [], syncedMessagePage: async () => ({ items: [] }), pendingAttachmentBodies: async () => [] },
    loadCursor: async () => null, saveCursor: async (cursor: unknown) => { checkpoints.push(cursor); },
    fetch: async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/profile")) return Response.json({ historyId: "10" });
      if (url.pathname.endsWith("/history")) return Response.json({ historyId: "10" });
      if (url.pathname.endsWith("/messages")) return Response.json({ messages: [{ id: "m" }] });
      return rawResponse();
    },
  } as unknown as ProviderContext;
  const sink: SyncSink = {
    signal: abort.signal, windowStart: 0,
    async ingest(batch) { writes.push(batch); }, async removeMessages(ids) { removed.push(ids); },
    async updateFlags() {}, async setBody() {}, async setSyncState() {}, async pendingMessageIds() { return new Set(); },
  };
  const provider = createGmailApiProvider(ctx, { tokens: { get: async () => "synthetic", invalidate() {} }, buildRaw: async () => new Uint8Array(), readTimeoutMs: 100 });
  return { provider, abort, writes, removed, checkpoints, async close() { abort.abort(); await provider.close(); pipeline.close(); }, sync: () => provider.sync(sink) };
}

it("excludes promotion waiting from the remaining network budget without resetting that budget", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  let resume!: () => void, waiting = false, settled = false, canceled = false;
  const queued = new Promise<void>((resolve) => { resume = resolve; });
  const source = new ReadableStream<Uint8Array>({
    start(controller) { for (let index = 0; index < 5; index++) controller.enqueue(new Uint8Array(65536)); },
    cancel() { canceled = true; },
  }, { highWaterMark: 0 });
  const t = setup(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 30)); return new Response(source); }, async () => { throw new Error("Must not process an unfinished body"); }, async (signal) => { waiting = true; await untilAborted(queued, signal); return () => {}; });
  const work = t.sync().catch((error: unknown) => error).finally(() => { settled = true; });
  try {
    await vi.advanceTimersByTimeAsync(31);
    const consumed = performance.now();
    expect(waiting).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(settled).toBe(false);
    resume(); await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(99 - consumed);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(await work).toMatchObject({ retryable: true });
    expect(canceled).toBe(true);
    expect(source.locked).toBe(false);
    expect(completedGmailCursors(t.checkpoints)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  } finally { resume(); await t.close(); await vi.runOnlyPendingTimersAsync(); await work; }
});

it.each(["complete", "reset", "caller", "timeout"] as const)("stops the network clock after body completion while local processing can %s", async (action) => {
  const raw = toBase64url(new TextEncoder().encode(`From: sender@example.test\r\n\r\n${"x".repeat(80000)}`));
  let finish!: () => void, entered!: () => void;
  const processing = new Promise<void>((resolve) => { entered = resolve; });
  const result = new Promise<void>((resolve) => { finish = resolve; });
  const t = setup(async () => Response.json({ id: "m", threadId: "t", raw }), async (signal) => {
    entered(); await untilAborted(result, signal);
    if (action === "timeout") throw new IncomingProcessingError("worker-timeout");
    return { kind: "gmail", metadata: { id: "m", threadId: "t" }, message: parsed };
  });
  const work = t.sync().then(() => undefined, (error: unknown) => error);
  try {
    await processing;
    vi.useFakeTimers();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    if (action === "reset") t.provider.reset!();
    if (action === "caller") t.abort.abort();
    finish();
    const error = await work;
    if (action === "complete") { expect(error).toBeUndefined(); expect(t.writes).toHaveLength(1); expect(completedGmailCursors(t.checkpoints)).toEqual([{ historyId: "10" }]); }
    else {
      expect(error).toBeDefined(); expect(t.writes).toEqual([]); expect(completedGmailCursors(t.checkpoints)).toEqual([]);
      if (action === "caller") expect(error).toBe(t.abort.signal.reason);
      if (action === "timeout") expect(error).toMatchObject({ code: "worker-timeout", retryable: false, network: false, ambiguous: false });
    }
    expect(t.removed).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  } finally { finish(); await t.close(); await work; }
});

it.each(["input-limit", "result-limit", "mime-limit-parts", "envelope-unavailable", "worker-unavailable", "worker-fault"] as const)("keeps %s local and private without deleting mail or promoting progress", async (code) => {
  const raw = toBase64url(new TextEncoder().encode(`From: sender@example.test\r\nContent-Type: text/html\r\n\r\n${"<span>bounded</span>".repeat(40)}`));
  let calls = 0;
  const t = setup(async () => Response.json({ id: "m", threadId: "t", raw }), async () => { calls++; throw new IncomingProcessingError(code); });
  try {
    const error = await t.sync().catch((error: unknown) => error);
    expect(calls).toBe(1);
    expect(error).toMatchObject({ retryable: false, network: false, ambiguous: false, expected: true });
    expect(error).not.toHaveProperty("status");
    expect(t.writes).toEqual([]);
    expect(t.removed).toEqual([]);
    expect(completedGmailCursors(t.checkpoints)).toEqual([]);
  } finally { await t.close(); }
});

it("rejects an oversized delivered backing allocation before processing and cancels its response", async () => {
  let canceled = false, calls = 0;
  const backing = new Uint8Array(1024 * 1024 + 1);
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(backing.subarray(0, 1)); },
    cancel() { canceled = true; },
  }));
  const t = setup(async () => response, async () => { calls++; throw new Error("Must not process rejected backing"); });
  try {
    await expect(t.sync()).rejects.toMatchObject({ code: "input-limit", retryable: false, network: false });
    expect(calls).toBe(0);
    expect(canceled).toBe(true);
    expect(response.body!.locked).toBe(false);
    expect(completedGmailCursors(t.checkpoints)).toEqual([]);
  } finally { await t.close(); }
});

it.each(["base64", "quoted-printable"] as const)("never falls back inline when encoded %s content requires an unavailable processor", async (encoding) => {
  const html = "<p>Exact body</p>".repeat(80);
  const encoded = encoding === "base64" ? Buffer.from(html).toString("base64") : html.replace(/</g, "=3C").replace(/>/g, "=3E");
  const raw = toBase64url(new TextEncoder().encode(`From: sender@example.test\r\nContent-Type: text/html\r\nContent-Transfer-Encoding: ${encoding}\r\n\r\n${encoded}`));
  let calls = 0;
  const t = setup(async () => Response.json({ id: "m", threadId: "t", raw }), async () => { calls++; throw new IncomingProcessingError("worker-unavailable"); });
  try {
    await expect(t.sync()).rejects.toMatchObject({ code: "worker-unavailable", retryable: false, network: false });
    expect(calls).toBe(1);
    expect(t.writes).toEqual([]);
    expect(completedGmailCursors(t.checkpoints)).toEqual([]);
  } finally { await t.close(); }
});

it.each(["caller", "reset", "close"] as const)("cancels a tiny MIME-triggered queued promotion on %s without dispatching the processor", async (action) => {
  const pipeline = new IncomingPipeline();
  const active = await pipeline.promote(99, new AbortController().signal);
  let enter!: () => void, calls = 0;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const raw = toBase64url(new TextEncoder().encode("From: sender@example.test\r\nContent-Type: application/octet-stream\r\n\r\nExact bounded bytes"));
  const t = setup(async () => Response.json({ id: "m", threadId: "t", raw }), async () => { calls++; throw new Error("Must not dispatch canceled local work"); }, (signal) => { enter(); return pipeline.promote(1, signal); });
  const work = t.sync().then(() => undefined, (error: unknown) => error);
  try {
    await Promise.race([entered, work.then(() => { throw new Error("MIME route did not queue for promotion"); })]);
    if (action === "caller") t.abort.abort();
    else if (action === "reset") t.provider.reset!();
    else await t.provider.close();
    const error = await work;
    if (action === "caller") expect(error).toBe(t.abort.signal.reason);
    else expect(error).toMatchObject({ retryable: true, network: false });
    expect(calls).toBe(0);
    expect(t.writes).toEqual([]); expect(completedGmailCursors(t.checkpoints)).toEqual([]);
    active();
    (await pipeline.promote(2, new AbortController().signal))();
  } finally { active(); await t.close(); await work; pipeline.close(); }
});
