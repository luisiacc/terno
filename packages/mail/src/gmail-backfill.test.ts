import { IncomingPipeline } from "./incoming";
import { createNodeIncomingProcessor } from "../../backend/src/incoming-worker";
import { afterEach, expect, it, vi } from "vitest";
import type { IncomingMessage } from "@terno/store";
import { createGmailApiProvider, toBase64url } from "./gmail-api";
import type { ProviderContext, SyncSink } from "./types";

// Plan 101: a widened window downloads the older mail, a bounded chunk a pass, resumable.
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 1);
const request = { since: NOW - 365 * DAY, until: NOW - 180 * DAY };
const closers: (() => Promise<void>)[] = [];
afterEach(async () => { vi.useRealTimers(); for (const c of closers.splice(0)) await c(); });

function setup(o: { older: number; stored?: Set<string>; cursor?: unknown; pageSize?: number; chunkMs?: number } = { older: 0 }) {
  const processor = createNodeIncomingProcessor();
  const incoming = new IncomingPipeline(processor);
  const older = Array.from({ length: o.older }, (_, i) => `old${String(i).padStart(4, "0")}`);
  const stored = o.stored ?? new Set<string>();
  const raw = toBase64url(new TextEncoder().encode("From: sender@example.test\r\nSubject: Old\r\nContent-Type: text/plain\r\n\r\nolder mail"));
  let cursor: unknown = o.cursor ?? { historyId: "10" };
  const queries: string[] = [];
  const downloads: string[] = [];
  const ingested: { ids: string[]; live: boolean }[] = [];
  const done: unknown[] = [];
  let more = 0;
  const ctx = {
    incoming, incomingProcessor: processor, account: { id: 1, email: "reader@example.test" }, config: {},
    store: { messageByProviderId: async (id: string) => (stored.has(id) ? { id: 1 } : null), syncedMessages: async () => [], syncedMessagePage: async () => ({ items: [] }), pendingAttachmentBodies: async () => [] },
    loadCursor: async () => cursor, saveCursor: async (value: unknown) => { cursor = structuredClone(value); },
    fetch: async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/profile")) return Response.json({ historyId: "10", emailAddress: "reader@example.test" });
      if (url.pathname.endsWith("/history")) return Response.json({ historyId: "10" });
      if (url.pathname.endsWith("/messages")) {
        queries.push(url.searchParams.get("q") ?? "");
        const size = o.pageSize ?? 500;
        const from = Number(url.searchParams.get("pageToken") ?? 0);
        const next = from + size < older.length ? String(from + size) : undefined;
        return Response.json({ messages: older.slice(from, from + size).map((id) => ({ id })), ...(next && { nextPageToken: next }) });
      }
      const id = url.pathname.split("/").at(-1)!;
      downloads.push(id);
      return Response.json({ id, threadId: id, raw, internalDate: String(NOW - 200 * DAY) });
    },
  } as unknown as ProviderContext;
  const abort = new AbortController();
  const sink: SyncSink = {
    signal: abort.signal, windowStart: NOW - 365 * DAY, windowDays: 365,
    backfill: request,
    backfillMore: () => { more++; },
    backfillDone: async (r) => { done.push(r); },
    async ingest(batch: IncomingMessage[], opts) { ingested.push({ ids: batch.map((m) => m.providerMsgId!), live: opts?.live === true }); batch.forEach((m) => stored.add(m.providerMsgId!)); },
    async updateFlags() {}, async removeMessages() {}, async setBody() {}, async setSyncState() {}, async pendingMessageIds() { return new Set(); },
  };
  const p = createGmailApiProvider(ctx, { tokens: { get: async () => "synthetic", invalidate() {} }, buildRaw: async () => new Uint8Array() });
  closers.push(async () => { await p.close(); await processor.close(); incoming.close(); });
  return { p, sink, abort, queries, downloads, ingested, done, stored, cursor: () => cursor, more: () => more };
}

it("lists only the requested span and downloads what isn't stored, as old mail (no notices), then says it's done", async () => {
  const stored = new Set(["old0001", "old0002"]);
  const t = setup({ older: 120, stored });
  await t.p.sync(t.sink);
  expect(t.queries).toEqual([`after:${Math.floor(request.since / 1000)} before:${Math.ceil(request.until / 1000)}`]);
  expect(t.downloads).toHaveLength(118);
  expect(t.downloads).not.toContain("old0001");
  expect(t.ingested.every((batch) => !batch.live)).toBe(true);
  expect(t.done).toEqual([request]);
  // the cursor forgets it once done (history goes on as before)
  expect(t.cursor()).toEqual({ historyId: "10" });
});

it("a span longer than a pass's chunk saves its page, asks for another pass, and resumes where it was", async () => {
  const t = setup({ older: 1200, pageSize: 500 });
  // two pages fit, then the clock says the chunk is over
  let now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  let pages = 0;
  const realSync = t.p.sync.bind(t.p);
  const pass = async () => { await realSync(t.sink); };
  // the chunk ends once the second page (20 batches of 50) is in
  const origIngest = t.sink.ingest;
  t.sink.ingest = async (batch, opts) => { await origIngest(batch, opts); pages++; if (pages === 20) now = 31_000; };
  await pass();
  expect(t.more()).toBe(1);
  expect(t.done).toEqual([]);
  const saved = t.cursor() as { historyId: string; backfill: { pages: number; next?: string } };
  expect(saved.historyId).toBe("10");
  expect(saved.backfill).toMatchObject({ since: request.since, until: request.until, pages: 2, next: "1000" });
  // the next pass goes on from the third page; nothing downloaded twice
  now = 0;
  const before = t.downloads.length;
  await pass();
  expect(t.done).toEqual([request]);
  expect(new Set(t.downloads).size).toBe(t.downloads.length);
  expect(t.downloads.length - before).toBe(200);
  expect(t.cursor()).toEqual({ historyId: "10" });
});

it("a first sync that reads the wider window itself leaves the backfill nothing to download twice", async () => {
  const t = setup({ older: 10, cursor: { reconciliation: { version: 1, stage: "restart" } } });
  await t.p.sync(t.sink);
  // the first sync downloaded all ten; the backfill's listing finds them stored, and the request is done
  expect(t.downloads).toHaveLength(10);
  expect(new Set(t.downloads).size).toBe(10);
  expect(t.done).toEqual([request]);
});

it("progress saved for another request is dropped: the new span lists from its start", async () => {
  const t = setup({ older: 5, cursor: { historyId: "10", backfill: { since: 1, until: 2, pages: 3, next: "999" } } });
  await t.p.sync(t.sink);
  expect(t.downloads).toHaveLength(5);
  expect(t.done).toEqual([request]);
});

it("a listing at its page limit starts over instead of calling the span done (Codex review)", async () => {
  const t = setup({ older: 5, cursor: { historyId: "10", backfill: { since: request.since, until: request.until, pages: 10_000, next: "3" } } });
  await t.p.sync(t.sink);
  expect(t.done).toEqual([]);
  expect(t.more()).toBe(1);
  expect((t.cursor() as { backfill: unknown }).backfill).toEqual({ since: request.since, until: request.until, pages: 0 });
  // the next pass lists from the start and finishes
  await t.p.sync(t.sink);
  expect(t.done).toEqual([request]);
});
