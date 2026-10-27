import { afterEach, expect, it } from "vitest";
import { createGmailApiProvider, toBase64url } from "./gmail-api";
import { IncomingPipeline } from "./incoming";
import type { IncomingMessage } from "@terno/store";
import type { MailProvider, ProviderContext, SyncSink } from "./types";

const providers: MailProvider[] = [];
afterEach(async () => { for (const provider of providers.splice(0)) await provider.close(); });

function setup(fail = false) {
  const pipeline = new IncomingPipeline();
  const label = "synthetic-label-".repeat(4000);
  const raw = toBase64url(new TextEncoder().encode("From: sender@example.test\r\nSubject: Synthetic\r\n\r\nSmall body\r\n"));
  let downloads = 0, firstWrite = 0, held = 0, maxHeld = 0, charges = 0;
  const batches: IncomingMessage[][] = [];
  const checkpoints: unknown[] = [];
  const failure = new Error("Synthetic durable refusal");
  const run = (accountId: number) => {
    const ctx = {
      account: { id: accountId }, config: {}, incoming: {
        acquire: pipeline.acquire.bind(pipeline), promote: pipeline.promote.bind(pipeline),
        retainCompleted(bytes: number) {
          const release = pipeline.retainCompleted(bytes);
          if (!release) return;
          expect(bytes).toBeGreaterThanOrEqual(label.length * 2);
          charges++; held += bytes; maxHeld = Math.max(held, maxHeld);
          let done = false;
          return () => { expect(done).toBe(false); done = true; held -= bytes; release(); };
        },
      },
      store: { messageByProviderId: async () => null, syncedMessages: async () => [], pendingAttachmentBodies: async () => [] },
      loadCursor: async () => null, saveCursor: async (value: unknown) => { checkpoints.push(value); },
      fetch: async (input: string | URL) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/profile")) return Response.json({ historyId: "10" });
        if (url.pathname.endsWith("/messages")) return Response.json({ messages: Array.from({ length: 50 }, (_, index) => ({ id: `m${index}` })) });
        downloads++;
        const id = url.pathname.split("/").at(-1)!;
        return Response.json({ id, threadId: id, labelIds: [label], raw });
      },
    } as unknown as ProviderContext;
    const provider = createGmailApiProvider(ctx, { tokens: { get: async () => "synthetic", invalidate() {} }, buildRaw: async () => new Uint8Array() });
    providers.push(provider);
    const sink: SyncSink = {
      signal: new AbortController().signal, windowStart: 0,
      async ingest(batch) { firstWrite ||= downloads; if (fail) throw failure; batches.push(batch); },
      async updateFlags() {}, async removeMessages() {}, async setBody() {}, async setSyncState() {}, async pendingMessageIds() { return new Set(); },
    };
    return provider.sync(sink);
  };
  return { run, pipeline, batches, checkpoints, failure, get firstWrite() { return firstWrite; }, get held() { return held; }, get maxHeld() { return maxHeld; }, get charges() { return charges; } };
}

it("charges completed metadata across accounts and makes progress before count batches fill", async () => {
  const t = setup();
  try {
    await Promise.all([t.run(1), t.run(2)]);
    expect(t.charges).toBeGreaterThan(0);
    expect(t.maxHeld).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(t.firstWrite).toBeLessThan(100);
    expect(t.batches.flat()).toHaveLength(100);
    expect(t.held).toBe(0);
    expect(t.checkpoints).toEqual([{ historyId: "10" }, { historyId: "10" }]);
  } finally { t.pipeline.close(); }
});

it("releases detached and discarded credits after durable failure without checkpointing", async () => {
  const t = setup(true);
  try {
    const outcomes = await Promise.allSettled([t.run(1), t.run(2)]);
    expect(outcomes).toEqual([{ status: "rejected", reason: t.failure }, { status: "rejected", reason: t.failure }]);
    expect(t.charges).toBeGreaterThan(0);
    expect(t.held).toBe(0);
    expect(t.checkpoints).toEqual([]);
    expect(t.pipeline.retainCompleted(4 * 1024 * 1024)).toBeTypeOf("function");
  } finally { t.pipeline.close(); }
});
