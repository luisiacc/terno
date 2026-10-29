import { expect, it, vi } from "vitest";
import { createGmailApiProvider } from "./gmail-api";
import { IncomingPipeline } from "./incoming";
import { IncomingProcessingError, type IncomingProcessor } from "./incoming-processing";
import { createNodeIncomingProcessor } from "../../backend/src/incoming-worker";
import type { IncomingMessage } from "@terno/store";
import type { ProviderContext, SyncSink } from "./types";

function resource(kind: "digest" | "explicit" | "comment", count = 2050) {
  const addresses = Array.from({ length: count }, (_, index) => `a${index}@x.test`);
  const to = Array.from({ length: Math.ceil(addresses.length / 30) }, (_, index) => addresses.slice(index * 30, (index + 1) * 30).join(", ")).join(",\r\n ");
  const child = `From: nested@example.test\r\nTo: ${to}\r\nSubject: Nested\r\nContent-Type: text/plain\r\n\r\nExact nested body\r\n`;
  const source = kind === "digest"
    ? `From: sender@example.test\r\nContent-Type: multipart/digest; boundary=synthetic\r\n\r\n--synthetic\r\n\r\n${child}--synthetic--\r\n`
    : `From: sender@example.test\r\nContent-Type: message${kind === "comment" ? "(synthetic)" : ""}/rfc822\r\n\r\n${child}`;
  const bytes = new TextEncoder().encode(JSON.stringify({ id: "m", threadId: "t", raw: Buffer.from(source).toString("base64url") }));
  expect(bytes.length).toBeLessThan(65536);
  expect(source.split("\n").length).toBeLessThan(128);
  expect(Math.max(...source.split("\n").map((line) => line.length))).toBeLessThan(4096);
  expect(source).not.toContain("<");
  if (kind !== "explicit") expect(source.toLowerCase()).not.toContain("message/");
  return bytes;
}

async function collect(bytes: Uint8Array, processor: IncomingProcessor) {
  const pipeline = new IncomingPipeline(processor);
  const writes: IncomingMessage[][] = [], checkpoints: unknown[] = [], removals: unknown[] = [];
  const ctx = {
    account: { id: 1 }, config: {}, incoming: pipeline, incomingProcessor: processor,
    store: { messageByProviderId: async () => null, syncedMessages: async () => [], pendingAttachmentBodies: async () => [] },
    loadCursor: async () => null, saveCursor: async (cursor: unknown) => { checkpoints.push(cursor); },
    fetch: async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/profile")) return Response.json({ historyId: "10" });
      if (url.pathname.endsWith("/history")) return Response.json({ historyId: "10" });
      if (url.pathname.endsWith("/messages")) return Response.json({ messages: [{ id: "m" }] });
      return new Response(bytes);
    },
  } as unknown as ProviderContext;
  const provider = createGmailApiProvider(ctx, { tokens: { get: async () => "synthetic", invalidate() {} }, buildRaw: async () => new Uint8Array() });
  const sink: SyncSink = {
    signal: new AbortController().signal, windowStart: 0,
    async ingest(batch) { writes.push(batch); }, async removeMessages(ids) { removals.push(ids); },
    async updateFlags() {}, async setBody() {}, async setSyncState() {}, async pendingMessageIds() { return new Set(); },
  };
  try {
    const error = await provider.sync(sink).then(() => undefined, (error: unknown) => error);
    return { error, writes, removals, checkpoints };
  } finally { await provider.close(); pipeline.close(); }
}

function unavailable(): IncomingProcessor {
  return { async run() { throw new IncomingProcessingError("worker-unavailable"); }, async whenIdle() {}, async close() {} };
}

it.each(["digest", "explicit", "comment"] as const)("requires the worker for nested %s and enforces its limits before publication", async (kind) => {
  const bytes = resource(kind);
  for (const available of [false, true]) {
    const processor = available ? createNodeIncomingProcessor() : unavailable();
    const calls = vi.spyOn(processor, "run");
    try {
      const result = await collect(bytes, processor);
      expect(calls).toHaveBeenCalledOnce();
      expect(result.error).toMatchObject({ code: available ? "mime-limit-addresses" : "worker-unavailable", retryable: false, network: false, ambiguous: false });
      expect(result.writes).toEqual([]); expect(result.removals).toEqual([]); expect(result.checkpoints).toEqual([]);
    } finally { await processor.close(); await processor.whenIdle(); }
  }
});

it.each(["digest", "explicit", "comment"] as const)("captures supported nested %s content below the worker budget", async (kind) => {
  const processor = createNodeIncomingProcessor();
  const calls = vi.spyOn(processor, "run");
  try {
    const result = await collect(resource(kind, 2), processor);
    expect(calls).toHaveBeenCalledOnce();
    expect(result.error).toBeUndefined();
    expect(result.writes.flat()).toHaveLength(1);
    expect(result.writes[0]![0]!.bodyText).toContain("Exact nested body");
    expect(result.writes[0]![0]!.bodyState).toBe("full");
    expect(result.checkpoints).toEqual([{ historyId: "10" }, { historyId: "10" }]);
  } finally { await processor.close(); await processor.whenIdle(); }
});

it.each([
  ["", true],
  ["Content-Type: text/plain; charset=utf-8\r\n", true],
  ["cOnTeNt-TyPe: TeXt/HtMl; charset=utf-8\r\n", true],
  ["Content-Type: text/html(synthetic)\r\n", false],
  ["Content-Type: text/plain-unknown\r\n", false],
  ["Content-Type: \"text/plain\"\r\n", false],
  ["Content-Type: text/plain\r\nContent-Type: message(synthetic)/rfc822\r\n", false],
] as const)("only qualifies a literal safe leaf declaration: %s", async (header, inline) => {
  const processor = unavailable();
  const calls = vi.spyOn(processor, "run");
  const raw = Buffer.from(`From: sender@example.test\r\n${header}\r\nExact body`).toString("base64url");
  const result = await collect(new TextEncoder().encode(JSON.stringify({ id: "m", threadId: "t", raw })), processor);
  expect(calls).toHaveBeenCalledTimes(inline ? 0 : 1);
  if (inline) { expect(result.error).toBeUndefined(); expect(result.writes).toHaveLength(1); }
  else { expect(result.error).toMatchObject({ code: "worker-unavailable" }); expect(result.writes).toEqual([]); expect(result.checkpoints).toEqual([]); }
});
