// Plan 259 stage 2a: the Graph provider's first-sync throughput gate, Gmail's (gmail-batches.perf.test.ts) for Outlook:
// a 20,000-message Inbox listed, downloaded (`$value`) and stored 50 at a time, then its first delta round (a filtered
// delta's 5,000) read back as flag updates, within a CPU budget by the message and a bounded number of requests,
// transactions and cursor writes.
import { IncomingReads } from "./incoming";
import { expect, it } from "vitest";
import { BUDGET_MULTIPLIER } from "../../db/src/test/perf";
import { threadCpuMs } from "../../db/src/test/timing";
import { createGraphApiProvider, GRAPH_PAGE } from "./graph-api";
import type { ProviderContext, SyncSink } from "./types";

it("keeps a first sync's listing, downloads and delta round within their CPU and transaction budgets, by the message", async () => {
  const count = 20_000;
  const graph = "https://graph.example/v1.0";
  const mime = new TextEncoder().encode("From: sender@example.test\r\nSubject: Synthetic\r\nContent-Type: text/plain\r\n\r\nOrdinary small mail");
  const envelope = (i: number) => ({ id: `m${i}`, receivedDateTime: new Date(Date.UTC(2026, 10, 1) - i * 60_000).toISOString(), isRead: false, isDraft: false, flag: { flagStatus: "notFlagged" }, parentFolderId: "inbox" });
  let requests = 0, downloads = 0, catalogReads = 0, listingPages = 0, deltaPages = 0, transactions = 0, flagWrites = 0, cursorWrites = 0, maxCursorBytes = 0;
  const stored = new Map<string, number>();
  const ctx = {
    incoming: new IncomingReads(),
    account: { id: 1, kind: "outlook", email: "ana@contoso.com" }, config: {},
    store: {
      messageByProviderId: async (id: string) => stored.has(id) ? { id: stored.get(id)!, subject: "", fromEmail: "" } : null,
      pendingAttachmentBodies: async () => [],
    },
    // the backend's cooperative turn (core.ts: the Node platform's setImmediate)
    yield: () => new Promise<void>((resolve) => setImmediate(resolve)),
    loadCursor: async () => null,
    saveCursor: async (value: unknown) => { cursorWrites++; maxCursorBytes = Math.max(maxCursorBytes, JSON.stringify(value).length); },
    fetch: async (input: string | URL) => {
      requests++;
      const url = new URL(String(input));
      const path = url.pathname.slice("/v1.0".length);
      if (path.endsWith("/$value")) { downloads++; return new Response(mime, { headers: { "content-type": "text/plain" } }); }
      if (path === "/me/mailFolders/inbox") { catalogReads++; return Response.json({ id: "inbox" }); }
      if (/^\/me\/mailFolders\/[a-z]+$/.test(path)) { catalogReads++; return Response.json({ error: { code: "ErrorFolderNotFound" } }, { status: 404 }); }
      if (path === "/me/mailFolders") { catalogReads++; return Response.json({ value: [{ id: "inbox", displayName: "Inbox", parentFolderId: "root", childFolderCount: 0 }] }); }
      const skip = Number(url.searchParams.get("$skiptoken") ?? 0);
      if (path === "/me/mailFolders/inbox/messages") {
        listingPages++;
        const end = Math.min(count, skip + GRAPH_PAGE);
        return Response.json({ value: Array.from({ length: end - skip }, (_, i) => envelope(skip + i)), ...(end < count && { "@odata.nextLink": `${graph}/me/mailFolders/inbox/messages?$skiptoken=${end}` }) });
      }
      if (path === "/me/mailFolders/inbox/messages/delta") {
        deltaPages++;
        // a filtered delta's first round: at most 5,000 (learn.microsoft.com/graph/delta-query-messages)
        const end = Math.min(5000, skip + GRAPH_PAGE);
        return Response.json({ value: Array.from({ length: end - skip }, (_, i) => envelope(skip + i)), ...(end < 5000 ? { "@odata.nextLink": `${graph}/me/mailFolders/inbox/messages/delta?$skiptoken=${end}` } : { "@odata.deltaLink": `${graph}/me/mailFolders/inbox/messages/delta?$deltatoken=done` }) });
      }
      throw new Error(`unexpected ${path}`);
    },
  } as unknown as ProviderContext;
  const sink: SyncSink = {
    signal: new AbortController().signal, windowStart: 0,
    async ingest(batch) {
      expect(batch).toHaveLength(50);
      transactions++;
      for (const m of batch) stored.set(m.providerMsgId!, stored.size + 1);
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
    async updateFlags(updates) { flagWrites += updates.length; await new Promise<void>((resolve) => setImmediate(resolve)); },
    async removeMessages() { throw new Error("unexpected removal"); },
    async setBody() {}, async setSyncState() {}, async pendingMessageIds() { return new Set(); },
    async setFolders() {},
  };
  const p = createGraphApiProvider(ctx, { endpoints: { graph }, tokens: { get: async () => "synthetic", invalidate() {} }, requestsPerSecond: Infinity });
  globalThis.gc?.();
  const cpu = threadCpuMs();
  // a first sync takes passes of FIRST_SYNC_CHUNK_MS; a fast one is one pass
  try { await p.sync(sink); }
  finally { await p.close(); }
  const elapsedCpu = threadCpuMs() - cpu;
  expect(elapsedCpu, `${count} provider/synthetic-sink CPU: ${elapsedCpu.toFixed(2)} ms`).toBeLessThanOrEqual((count / 20) * BUDGET_MULTIPLIER);
  expect(stored.size).toBe(count);
  expect(downloads).toBe(count);
  expect(transactions).toBe(count / 50);
  expect(listingPages).toBe(count / GRAPH_PAGE);
  expect(deltaPages).toBe(5000 / GRAPH_PAGE);
  expect(flagWrites).toBe(5000);
  // nine well-known names (six roles, three never synced) and the folder list
  expect(catalogReads).toBe(10);
  expect(requests).toBe(count + listingPages + deltaPages + catalogReads);
  // the listing's start, a place a page, the delta's start and its pages
  expect(cursorWrites).toBe(1 + count / GRAPH_PAGE + 5000 / GRAPH_PAGE);
  expect(maxCursorBytes).toBeLessThan(512);
});
