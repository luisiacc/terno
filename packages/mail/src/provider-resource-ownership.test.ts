import { expect, it } from "vitest";
import { IncomingPipeline } from "./incoming";
import { createGmailApiProvider, toBase64url } from "./gmail-api";
import type { ProviderContext, SyncSink } from "./types";

async function witness(suppressRelease: boolean) {
  const pipeline = new IncomingPipeline();
  const original = pipeline.retainCompleted;
  const suppressed: (() => void)[] = [];
  let held = 0, charged = 0, maxHeld = 0, written = 0;
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const checkpoints: unknown[] = [];
  pipeline.retainCompleted = (bytes) => {
    const owned = original.call(pipeline, bytes);
    if (!owned) return;
    held += bytes; charged++; maxHeld = Math.max(maxHeld, held);
    return () => {
      if (suppressRelease) suppressed.push(() => { held -= bytes; owned(); });
      else { held -= bytes; owned(); }
    };
  };
  const raw = toBase64url(new TextEncoder().encode("From: sender@example.test\r\nContent-Type: text/plain\r\n\r\nSynthetic"));
  const ctx = {
    account: { id: 1, email: "me@example.test" }, config: {}, incoming: pipeline,
    store: { messageByProviderId: async () => null, syncedMessagePage: async () => ({ items: [] }), pendingAttachmentBodies: async () => [] },
    loadCursor: async () => null, saveCursor: async (value: unknown) => { checkpoints.push(structuredClone(value)); },
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (init?.method && init.method !== "GET") throw new Error("Unexpected synthetic method");
      if (url.origin !== "https://gmail.googleapis.com") throw new Error("Unexpected synthetic origin");
      const path = url.pathname.replace("/gmail/v1/users/me", "");
      if (path === "/profile") return Response.json({ historyId: "10" });
      if (path === "/history") return Response.json({ historyId: "10" });
      if (path === "/messages") return Response.json({ messages: Array.from({ length: 50 }, (_, i) => ({ id: `m${i}` })) });
      if (!/^\/messages\/m(?:[0-9]|[1-4][0-9])$/.test(path) || url.searchParams.get("format") !== "raw") throw new Error("Unexpected synthetic route");
      const id = path.split("/").at(-1)!;
      return Response.json({ id, threadId: id, raw });
    },
  } as unknown as ProviderContext;
  const provider = createGmailApiProvider(ctx, { tokens: { get: async () => "synthetic", invalidate() {} }, buildRaw: async () => new Uint8Array() });
  const sink: SyncSink = {
    signal: new AbortController().signal, windowStart: 0,
    async ingest(batch) { entered(); await gate; written += batch.length; },
    async pendingMessageIds() { return new Set(); }, async setBody() {}, async setSyncState() {}, async removeMessages() {}, async updateFlags() {},
  };
  const work = provider.sync(sink);
  void work.catch(() => {});
  try {
    await Promise.race([started, work.then(() => { throw new Error("Missing blocked ingest"); })]);
    expect(held).toBeGreaterThan(0);
    expect(checkpoints.at(-1)).toMatchObject({ reconciliation: { stage: "enumerate", pages: 0 } });
    release(); await work;
    expect(written).toBe(50); expect(charged).toBe(50);
    expect(maxHeld).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(checkpoints.at(-1)).toEqual({ historyId: "10" });
    // Same real completed-credit predicate for ordinary and suppressed-release runs.
    expect(held, "completed credits released after durable ingest").toBe(0);
  } finally {
    release(); await work.catch(() => {});
    pipeline.retainCompleted = original;
    for (const releaseOwned of suppressed) releaseOwned();
    await provider.close(); pipeline.close();
    expect(pipeline.retainCompleted).toBe(original);
    expect(held).toBe(0);
  }
}

it("releases actual adapter credits after blocked durable ingest", async () => { await witness(false); });
it("detects removal of release through the same ownership predicate and restores the seam", async () => {
  await expect(witness(true)).rejects.toThrow("completed credits released after durable ingest");
});

it("observes six 1MiB native chunks waiting outside completed credits before promotion", async () => {
  const pipeline = new IncomingPipeline();
  const releasePromotion = await pipeline.promote(99, new AbortController().signal);
  let promotions = 0, pulls = 0, cancelled = 0, charged = 0;
  const backing = new Set<ArrayBufferLike>();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const ctx = {
    account: { id: 1, email: "me@example.test" }, config: {},
    incoming: {
      acquire: pipeline.acquire.bind(pipeline),
      promote(...args: Parameters<IncomingPipeline["promote"]>) {
        if (++promotions === 6) entered();
        return pipeline.promote(...args);
      },
      retainCompleted(bytes: number) { charged += bytes; return pipeline.retainCompleted(bytes); },
    },
    store: { messageByProviderId: async () => null, syncedMessagePage: async () => ({ items: [] }), pendingAttachmentBodies: async () => [] },
    loadCursor: async () => null, saveCursor: async () => { throw new Error("Blocked raw cannot checkpoint"); },
    fetch: async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin !== "https://gmail.googleapis.com") throw new Error("Unexpected synthetic origin");
      const path = url.pathname.replace("/gmail/v1/users/me", "");
      if (path === "/profile") return Response.json({ historyId: "10" });
      if (path === "/messages") return Response.json({ messages: Array.from({ length: 6 }, (_, i) => ({ id: `m${i}` })) });
      if (!/^\/messages\/m[0-5]$/.test(path) || url.searchParams.get("format") !== "raw") throw new Error("Unexpected synthetic route");
      let chunk: Uint8Array | undefined;
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          if (chunk) throw new Error("Pulled beyond blocked promotion");
          chunk = new Uint8Array(1024 * 1024).fill(65);
          const prefix = new TextEncoder().encode(`{"id":"${path.split("/").at(-1)}","threadId":"synthetic","raw":"`);
          chunk.set(prefix); backing.add(chunk.buffer); pulls++;
          controller.enqueue(chunk);
        },
        cancel() { cancelled++; if (chunk) backing.delete(chunk.buffer); chunk = undefined; },
      }, { highWaterMark: 0 }));
    },
  } as unknown as ProviderContext;
  const provider = createGmailApiProvider(ctx, { tokens: { get: async () => "synthetic", invalidate() {} }, buildRaw: async () => new Uint8Array() });
  const sink: SyncSink = {
    signal: new AbortController().signal, windowStart: 0,
    async ingest() { throw new Error("Blocked raw cannot ingest"); },
    async pendingMessageIds() { return new Set(); }, async setBody() {}, async setSyncState() {}, async removeMessages() {}, async updateFlags() {},
  };
  // Initial progress is legitimate; no raw page may advance it.
  let checkpoints = 0;
  ctx.saveCursor = async () => { checkpoints++; };
  const work = provider.sync(sink);
  void work.catch(() => {});
  try {
    await Promise.race([started, work.then(() => { throw new Error("Missing promotion wait"); })]);
    expect(pulls).toBe(6); expect(backing.size).toBe(6);
    expect([...backing].reduce((n, buffer) => n + buffer.byteLength, 0)).toBe(6 * 1024 * 1024);
    expect(charged).toBe(0); expect(checkpoints).toBe(1);
    provider.reset?.();
    await expect(work).rejects.toBeDefined();
    expect(cancelled).toBe(6); expect(backing.size).toBe(0);
  } finally {
    provider.reset?.(); releasePromotion();
    await work.catch(() => {}); await provider.close(); pipeline.close();
  }
});
