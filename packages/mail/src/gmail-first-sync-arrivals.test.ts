import { IncomingPipeline } from "./incoming";
import { createNodeIncomingProcessor } from "../../backend/src/incoming-worker";
import { afterEach, expect, it, vi } from "vitest";
import type { IncomingMessage } from "@terno/store";
import { createGmailApiProvider, toBase64url } from "./gmail-api";
import type { ProviderContext, SyncSink } from "./types";

// Plan 102: new mail arrives during a long first sync, a chunk at a time.
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 1);
const closers: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const c of closers.splice(0)) await c(); });

function setup(o: { mailbox: number; cursor?: unknown; arrivals?: () => string[]; historyId?: () => string; listed?: () => string[]; historyGone?: () => boolean }) {
  const processor = createNodeIncomingProcessor();
  const incoming = new IncomingPipeline(processor);
  const mailbox = Array.from({ length: o.mailbox }, (_, i) => `m${String(i).padStart(5, "0")}`);
  const stored = new Set<string>();
  const raw = toBase64url(new TextEncoder().encode("From: sender@example.test\r\nSubject: Mail\r\nContent-Type: text/plain\r\n\r\nbody"));
  let cursor: unknown = o.cursor ?? null;
  const downloads: string[] = [];
  const ingested: { ids: string[]; live: boolean }[] = [];
  const histories: string[] = [];
  let again = 0;
  const ctx = {
    incoming, incomingProcessor: processor, account: { id: 1, email: "reader@example.test" }, config: {},
    store: { messageByProviderId: async (id: string) => (stored.has(id) ? { id: 1 } : null), syncedMessages: async () => [], syncedMessagePage: async () => ({ items: [] }), pendingAttachmentBodies: async () => [] },
    loadCursor: async () => cursor, saveCursor: async (value: unknown) => { cursor = structuredClone(value); },
    fetch: async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/profile")) return Response.json({ historyId: o.historyId?.() ?? "100", emailAddress: "reader@example.test" });
      if (url.pathname.endsWith("/history")) {
        histories.push(url.searchParams.get("startHistoryId")!);
        if (o.historyGone?.()) return Response.json({ error: { code: 404 } }, { status: 404 });
        const added = o.arrivals?.() ?? [];
        return Response.json({ historyId: o.historyId?.() ?? "100", ...(added.length && { history: [{ id: "101", messagesAdded: added.map((id) => ({ message: { id } })) }] }) });
      }
      if (url.pathname.endsWith("/labels")) return Response.json({ labels: [] });
      if (url.pathname.endsWith("/messages")) {
        const from = Number(url.searchParams.get("pageToken") ?? 0);
        const next = from + 500 < mailbox.length ? String(from + 500) : undefined;
        // what arrived since appears at the top of the listing (newest first)
        const top = from === 0 ? (o.listed?.() ?? []) : [];
        return Response.json({ messages: [...top, ...mailbox.slice(from, from + 500)].map((id) => ({ id })), ...(next && { nextPageToken: next }) });
      }
      const id = url.pathname.split("/").at(-1)!;
      downloads.push(id);
      // the mailbox's mail came before the sync began; new mail after
      return Response.json({ id, threadId: id, raw, internalDate: String(id.startsWith("fresh") ? NOW + 1000 : NOW - 10 * DAY) });
    },
  } as unknown as ProviderContext;
  const sink: SyncSink = {
    signal: new AbortController().signal, windowStart: NOW - 180 * DAY, windowDays: 180,
    again: () => { again++; },
    async ingest(batch: IncomingMessage[], opts) { ingested.push({ ids: batch.map((m) => m.providerMsgId!), live: opts?.live === true }); batch.forEach((m) => stored.add(m.providerMsgId!)); },
    async updateFlags() {}, async removeMessages() {}, async setBody() {}, async setSyncState() {}, async pendingMessageIds() { return new Set(); },
  };
  const p = createGmailApiProvider(ctx, { tokens: { get: async () => "synthetic", invalidate() {} }, buildRaw: async () => new Uint8Array() });
  closers.push(async () => { await p.close(); await processor.close(); incoming.close(); });
  return { p, sink, downloads, ingested, histories, stored, cursor: () => cursor as { reconciliation?: Record<string, unknown>; historyId?: string }, again: () => again };
}

it("a first sync longer than its chunk stops between batches, asks for another pass, and that pass reads new mail first, as live mail", async () => {
  let now = NOW;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  let arrivals: string[] = [];
  const t = setup({ mailbox: 1200, arrivals: () => arrivals, historyId: () => (arrivals.length ? "105" : "100") });
  // the first batch takes past the chunk (a page is minutes under the quota: it stops between batches)
  const ingest = t.sink.ingest;
  t.sink.ingest = async (batch, opts) => { await ingest(batch, opts); now = NOW + 61_000; };
  await t.p.sync(t.sink);
  expect(t.again()).toBe(1);
  expect(t.downloads).toHaveLength(50);
  expect(t.cursor().reconciliation).toMatchObject({ stage: "enumerate", pages: 0, baseline: "100", startedAt: NOW });
  // a new message arrives; the next pass downloads it first, live, then goes on (the page again, its stored skipped)
  arrivals = ["fresh1"];
  now = NOW + 120_000;
  t.sink.ingest = ingest;
  const started = now;
  vi.spyOn(Date, "now").mockImplementation(() => started);
  await t.p.sync(t.sink);
  expect(t.histories[0]).toBe("100");
  expect(t.ingested.find((b) => b.ids.includes("fresh1"))).toEqual({ ids: ["fresh1"], live: true });
  expect(t.downloads.indexOf("fresh1")).toBe(50);
  expect(new Set(t.downloads).size).toBe(t.downloads.length);
  // the first sync finished in this pass; nothing of the mailbox notified
  expect(t.cursor().reconciliation).toBeUndefined();
  expect(t.ingested.filter((b) => b.ids.some((id) => id.startsWith("m"))).every((b) => !b.live)).toBe(true);
});

it("a new message the listing finds before history says so is still new mail: it notifies (Codex review)", async () => {
  vi.spyOn(Date, "now").mockImplementation(() => NOW);
  // fresh2 was received after the sync began, and the listing's first page shows it at the top
  const t = setup({ mailbox: 30, listed: () => ["fresh2"] });
  await t.p.sync(t.sink);
  const mixed = t.ingested.filter((b) => b.ids.includes("fresh2"));
  expect(mixed).toEqual([{ ids: ["fresh2"], live: true }]);
  expect(t.ingested.filter((b) => b.ids.some((id) => id.startsWith("m"))).every((b) => !b.live)).toBe(true);
});

it("history gone for the look at new mail: it starts again from now instead of failing every chunk (Codex review)", async () => {
  let now = NOW;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const t = setup({ mailbox: 1200, cursor: { reconciliation: { version: 1, email: "reader@example.test", intent: "days:180", after: Math.floor((NOW - 180 * DAY) / 1000), baseline: "100", stage: "enumerate", pages: 1, next: "500", peek: "104", startedAt: NOW } }, historyId: () => "200", historyGone: () => true });
  const ingest = t.sink.ingest;
  t.sink.ingest = async (batch, opts) => { await ingest(batch, opts); now = NOW + 61_000; };
  await t.p.sync(t.sink);
  expect(t.histories[0]).toBe("104");
  // paused after a batch, the look's cursor now at the profile's id: the next chunk reads from there
  expect(t.cursor().reconciliation).toMatchObject({ peek: "200", next: "500" });
});

it("the next look at new mail starts where the last one ended", async () => {
  const t = setup({ mailbox: 10, cursor: { reconciliation: { version: 1, email: "reader@example.test", intent: "days:180", after: Math.floor((NOW - 180 * DAY) / 1000), baseline: "100", stage: "enumerate", pages: 1, next: "5", peek: "104" } }, historyId: () => "104" });
  await t.p.sync(t.sink);
  expect(t.histories[0]).toBe("104");
});
