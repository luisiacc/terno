import { IncomingPipeline } from "./incoming";
import { createNodeIncomingProcessor } from "../../backend/src/incoming-worker";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage } from "@terno/store";
import { createGmailApiProvider, toBase64url } from "./gmail-api";
import type { ProviderContext, SyncSink } from "./types";

// Plan 102: new mail arrives during a long first sync, a chunk at a time.
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 1);
const closers: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const c of closers.splice(0)) await c(); });

function setup(o: { mailbox: number; cursor?: unknown; arrivals?: () => string[]; historyId?: () => string; listed?: () => string[]; historyGone?: () => boolean; estimate?: number; pageSize?: number; overflowCatchup?: () => boolean; refresh?: { labels: Record<string, string[]>; gone: Set<string> }; history?: (url: URL) => unknown; minimalStatus?: (id: string) => number | undefined }) {
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
  const flagged: { id: string; labels: string[] | undefined }[] = [];
  const removed: number[] = [];
  const progress: unknown[] = [];
  let refreshed = 0;
  const ctx = {
    incoming, incomingProcessor: processor, account: { id: 1, email: "reader@example.test" }, config: {},
    store: {
      // each stored message its own local id (its place in the store); "self…" ones are yours
      messageByProviderId: async (id: string) => (stored.has(id) ? { id: [...stored].indexOf(id) + 1, subject: "Mail", fromEmail: id.startsWith("self") ? "Reader@example.test" : "sender@example.test" } : null), syncedMessages: async () => [], pendingAttachmentBodies: async () => [],
      // the refresh reads every stored message again, 50 a page (ids by position)
      syncedMessagePage: async (after?: string) => {
        const all = [...stored].sort();
        const from = after === undefined ? 0 : Number(after);
        const items = all.slice(from, from + 50).map((providerMsgId, i) => ({ id: from + i + 1, providerMsgId }));
        return { items, ...(items.length && { next: String(from + items.length).padStart(8, "0") }) };
      },
    },
    loadCursor: async () => cursor, saveCursor: async (value: unknown) => { cursor = structuredClone(value); },
    fetch: async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/profile")) return Response.json({ historyId: o.historyId?.() ?? "100", emailAddress: "reader@example.test" });
      if (url.pathname.endsWith("/history")) {
        histories.push(url.searchParams.get("startHistoryId")!);
        // the catch-up (after the refresh's reads; the look at new mail asks for the same types) answering more than a
        // page can hold: an overflow
        if (o.overflowCatchup?.() && refreshed > 0) return Response.json({ historyId: o.historyId?.() ?? "100", history: Array.from({ length: 501 }, (_, i) => ({ id: String(200 + i) })) });
        if (o.historyGone?.()) return Response.json({ error: { code: 404 } }, { status: 404 });
        const page = o.history?.(url);
        if (page) return Response.json(page);
        const added = o.arrivals?.() ?? [];
        return Response.json({ historyId: o.historyId?.() ?? "100", ...(added.length && { history: [{ id: "101", messagesAdded: added.map((id) => ({ message: { id } })) }] }) });
      }
      if (url.pathname.endsWith("/labels")) return Response.json({ labels: [] });
      if (url.pathname.endsWith("/messages")) {
        const size = o.pageSize ?? 500;
        const from = Number(url.searchParams.get("pageToken") ?? 0);
        const next = from + size < mailbox.length ? String(from + size) : undefined;
        // what arrived since appears at the top of the listing (newest first)
        const top = from === 0 ? (o.listed?.() ?? []) : [];
        return Response.json({ messages: [...top, ...mailbox.slice(from, from + size)].map((id) => ({ id })), ...(next && { nextPageToken: next }), ...(o.estimate !== undefined && { resultSizeEstimate: o.estimate }) });
      }
      const id = url.pathname.split("/").at(-1)!;
      // a refresh's minimal read: the message's labels now, or gone
      if (url.searchParams.get("format") === "minimal") {
        refreshed++;
        const status = o.minimalStatus?.(id);
        if (status) return Response.json({ error: { code: status } }, { status });
        if (o.refresh?.gone.has(id)) return Response.json({ error: { code: 404 } }, { status: 404 });
        return Response.json({ id, labelIds: o.refresh?.labels[id] ?? ["INBOX"] });
      }
      downloads.push(id);
      // the mailbox's mail came before the sync began; new mail after
      return Response.json({ id, threadId: id, raw, internalDate: String(id.startsWith("fresh") ? NOW + 1000 : NOW - 10 * DAY) });
    },
  } as unknown as ProviderContext;
  const sink: SyncSink = {
    signal: new AbortController().signal, windowStart: NOW - 180 * DAY, windowDays: 180,
    again: () => { again++; },
    progress: (p) => { progress.push(p); },
    async ingest(batch: IncomingMessage[], opts) { ingested.push({ ids: batch.map((m) => m.providerMsgId!), live: opts?.live === true }); batch.forEach((m) => stored.add(m.providerMsgId!)); },
    async updateFlags(updates) { flagged.push(...updates.map((u) => ({ id: u.expectedProviderMsgId ?? "", labels: u.gmailLabels }))); },
    async removeMessages(ids) { removed.push(...ids); }, async setBody() {}, async setSyncState() {}, async pendingMessageIds() { return new Set(); },
  };
  const p = createGmailApiProvider(ctx, { tokens: { get: async () => "synthetic", invalidate() {} }, buildRaw: async () => new Uint8Array() });
  closers.push(async () => { await p.close(); await processor.close(); incoming.close(); });
  return { p, sink, progress, flagged, removed, downloads, ingested, histories, stored, cursor: () => cursor as { reconciliation?: Record<string, unknown>; historyId?: string }, again: () => again };
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

it("plan 103: a first sync says how far it is: Google's estimate, the oldest date reached, then finishing", async () => {
  vi.spyOn(Date, "now").mockImplementation(() => NOW);
  const t = setup({ mailbox: 120, estimate: 6000 });
  await t.p.sync(t.sink);
  const reports = t.progress as { done?: number; total?: number; unit?: string; reachedAt?: number; finishing?: boolean }[];
  // a report a batch of 50: done counts up against the estimate, the oldest mail reached alongside
  expect(reports.slice(0, 3)).toEqual([
    { done: 50, total: 6000, unit: "messages", reachedAt: NOW - 10 * DAY, since: Math.floor((NOW - 180 * DAY) / 1000) * 1000 },
    { done: 100, total: 6000, unit: "messages", reachedAt: NOW - 10 * DAY, since: Math.floor((NOW - 180 * DAY) / 1000) * 1000 },
    { done: 120, total: 6000, unit: "messages", reachedAt: NOW - 10 * DAY, since: Math.floor((NOW - 180 * DAY) / 1000) * 1000 },
  ]);
  // all downloaded: the flags are read again
  expect(reports.at(-1)).toEqual({ finishing: true, unit: "messages", done: 6000, total: 6000 });
});

it("plan 103 (Codex review): pages that aren't full count what they held, and an estimate already reached shows no count", async () => {
  vi.spyOn(Date, "now").mockImplementation(() => NOW);
  // 360 messages in pages of 120; Google guessed 200
  const t = setup({ mailbox: 360, estimate: 200, pageSize: 120 });
  await t.p.sync(t.sink);
  const reports = (t.progress as { done?: number; total?: number; finishing?: boolean }[]).filter((r) => !r.finishing);
  // counted, not pages × 500: the second page's first batch is 170 done, not 550
  expect(reports.map((r) => r.done)).toEqual([50, 100, 120, 170, 220, 240, 290, 340, 360]);
  // the estimate while the pages listed are under it; past it with pages to come, no count ("0 left" would be wrong);
  // the last page knows it exactly
  expect(reports.map((r) => r.total)).toEqual([200, 200, 200, undefined, undefined, undefined, 360, 360, 360]);
});

describe("plan 104: a long first sync doesn't replay hours of history, and never leaves its window", () => {
  it("a long sync catches up from where its refresh began, not from its start", async () => {
    let now = NOW;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    // the mailbox's history moves on while the sync runs: 100 when it began, 150 after
    let id = "100";
    const t = setup({ mailbox: 10, historyId: () => id });
    const ingest = t.sink.ingest;
    // the downloads took over ten minutes (the chunk pauses; the next pass goes on)
    t.sink.ingest = async (batch, opts) => { await ingest(batch, opts); now = NOW + 11 * 60_000; id = "150"; };
    await t.p.sync(t.sink);
    expect(t.histories).toEqual([]);
    now = NOW + 12 * 60_000;
    t.sink.ingest = ingest;
    await t.p.sync(t.sink);
    // the look at new mail as the pass resumes, again as the refresh begins, then the catch-up from there (not 100)
    expect(t.histories).toEqual(["100", "150", "150"]);
    expect(t.cursor()).toEqual({ historyId: "150" });
  });

  it("a short one keeps its baseline (no extra request)", async () => {
    vi.spyOn(Date, "now").mockImplementation(() => NOW);
    const t = setup({ mailbox: 10 });
    await t.p.sync(t.sink);
    expect(t.histories).toEqual(["100"]);
  });

  it("a look that lost history keeps the catch-up at the baseline (nothing between is skipped)", async () => {
    const t = setup({ mailbox: 10, cursor: { reconciliation: { version: 1, email: "reader@example.test", intent: "days:180", after: Math.floor((NOW - 180 * DAY) / 1000), baseline: "100", stage: "refresh", pages: 1, peek: "120", gap: true, startedAt: NOW - DAY } }, historyId: () => "130" });
    await t.p.sync(t.sink).catch(() => {});
    expect(t.histories[0]).toBe("120");
    expect(t.histories.at(-1)).toBe("100");
  });

  it("a listing of all mail left by an older recovery goes on within the window", async () => {
    vi.spyOn(Date, "now").mockImplementation(() => NOW);
    const t = setup({ mailbox: 10, cursor: { reconciliation: { version: 1, email: "reader@example.test", intent: "days:180", after: 0, baseline: "100", stage: "enumerate", pages: 4, next: "2000", listed: 2000, startedAt: NOW } } });
    await t.p.sync(t.sink);
    expect(t.cursor().reconciliation).toBeUndefined();
    // the ten in the window are here; the all-mail listing's page tokens weren't reused
    expect(t.downloads).toHaveLength(10);
  });
});

describe("plan 104 (Codex review)", () => {
  it("a long sync converges: a message that came just before the refresh, a label changed meanwhile, one deleted", async () => {
    let now = NOW;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let id = "100";
    let arrivals: string[] = [];
    const refresh = { labels: { m00003: ["INBOX", "STARRED"] } as Record<string, string[]>, gone: new Set(["m00005"]) };
    const t = setup({ mailbox: 10, historyId: () => id, arrivals: () => arrivals, refresh });
    const ingest = t.sink.ingest;
    t.sink.ingest = async (batch, opts) => { await ingest(batch, opts); now = NOW + 11 * 60_000; };
    await t.p.sync(t.sink);
    // between the passes: a message arrives, m00003 is starred, m00005 deleted
    arrivals = ["fresh9"]; id = "160";
    t.sink.ingest = ingest;
    await t.p.sync(t.sink);
    expect(t.ingested.find((b) => b.ids.includes("fresh9"))).toEqual({ ids: ["fresh9"], live: true });
    expect(t.flagged.find((f) => f.id === "m00003")?.labels).toEqual(["INBOX", "STARRED"]);
    expect(t.removed).toHaveLength(1);
    expect(t.cursor()).toEqual({ historyId: "160" });
  });

  it("a catch-up from a refresh that overflows reads the flags again, never lists the window again", async () => {
    let now = NOW;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let overflow = true;
    const t = setup({ mailbox: 10, overflowCatchup: () => overflow });
    const ingest = t.sink.ingest;
    t.sink.ingest = async (batch, opts) => { await ingest(batch, opts); now = NOW + 11 * 60_000; };
    await t.p.sync(t.sink);
    t.sink.ingest = ingest;
    await t.p.sync(t.sink).catch(() => {});
    // back to the refresh (its listing kept), not a restart
    expect(t.cursor().reconciliation).toMatchObject({ stage: "refresh" });
    expect(t.cursor().reconciliation).not.toHaveProperty("refreshFrom");
    overflow = false;
    const before = t.downloads.length;
    await t.p.sync(t.sink);
    expect(t.downloads.length).toBe(before);
    expect(t.cursor().reconciliation).toBeUndefined();
  });

  it("a first sync legitimately running for days keeps its window and its place (only all-mail listings are clamped)", async () => {
    vi.spyOn(Date, "now").mockImplementation(() => NOW);
    const after = Math.floor((NOW - 182 * DAY) / 1000);
    const t = setup({ mailbox: 600, cursor: { reconciliation: { version: 1, email: "reader@example.test", intent: "days:180", after, baseline: "100", stage: "enumerate", pages: 1, next: "500", listed: 500, startedAt: NOW - 2 * DAY } } });
    await t.p.sync(t.sink);
    // it went on from its saved page: only the last 100 were downloaded
    expect(t.downloads.filter((id) => id.startsWith("m"))).toHaveLength(100);
  });
});

describe("plan 227: changes during a first sync", () => {
  // a first sync that is still listing: 1,200 messages, each pass stops after a batch of 50
  const listing = (o: Omit<Parameters<typeof setup>[0], "mailbox">) => {
    let now = NOW;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const t = setup({ mailbox: 1200, ...o });
    const ingest = t.sink.ingest;
    t.sink.ingest = async (batch, opts) => { await ingest(batch, opts); now += 61_000; };
    return { ...t, pass: async () => { now += 1000; await t.p.sync(t.sink); } };
  };
  const added = (ids: string[]) => ({ id: "101", messagesAdded: ids.map((id) => ({ message: { id } })) });
  const relabeled = (ids: string[]) => ({ id: "102", labelsAdded: ids.map((id) => ({ message: { id }, labelIds: ["STARRED"] })) });

  it("a message you sent to yourself shows its labels (INBOX too) at the next look, while the listing still runs", async () => {
    let history: unknown[] = [];
    const t = listing({ history: () => ({ historyId: history.length ? "105" : "100", history }), refresh: { labels: { self: ["SENT", "INBOX", "UNREAD"] }, gone: new Set() } });
    await t.pass();
    // the send stored it under Gmail's id at once; Gmail's history says it was added (and delivered to you)
    t.stored.add("self");
    history = [added(["self"])];
    await t.pass();
    expect(t.flagged).toEqual([{ id: "self", labels: ["SENT", "INBOX", "UNREAD"] }]);
    expect(t.downloads).not.toContain("self");
    expect(t.cursor().reconciliation).toMatchObject({ stage: "enumerate", peek: "105" });
  });

  it("your send that Gmail puts in your Inbox a look later still goes before the look's downloads (Codex review)", async () => {
    let history: unknown[] = [];
    const labels: Record<string, string[]> = { self: ["SENT"] };
    const t = listing({ history: () => ({ historyId: history.length ? "105" : "100", history }), refresh: { labels, gone: new Set() } });
    await t.pass();
    t.stored.add("self");
    history = [added(["self"])];
    await t.pass();
    expect(t.flagged).toEqual([{ id: "self", labels: ["SENT"] }]);
    // delivered to you, with a hundred new messages and other changes in the same look
    labels.self = ["SENT", "INBOX"];
    history = [added(Array.from({ length: 100 }, (_, i) => `fresh${i}`)), relabeled(["self", "m00001", "m00002"])];
    const before = t.downloads.length;
    let downloadsThen = -1;
    const update = t.sink.updateFlags;
    t.sink.updateFlags = async (updates) => { if (updates.some((u) => u.expectedProviderMsgId === "self")) downloadsThen = t.downloads.length; await update(updates); };
    await t.pass();
    expect(t.flagged.at(-1)?.id).not.toBe("self");
    expect(t.flagged.find((f) => f.id === "self" && f.labels?.includes("INBOX"))).toBeDefined();
    expect(downloadsThen).toBe(before);
  });

  it("a stored message relabeled elsewhere is read again; one not stored yet, or deleted in the same look, is not; a 404 removes nothing", async () => {
    let history: unknown[] = [];
    const t = listing({ history: () => ({ historyId: history.length ? "105" : "100", history }), refresh: { labels: {}, gone: new Set(["m00002"]) } });
    await t.pass();
    history = [relabeled(["m00001", "m00002", "m00003", "m01100"]), { id: "103", messagesDeleted: [{ message: { id: "m00003" } }] }];
    await t.pass();
    // m00002 answered 404: the catch-up's to remove, as plan 102 left deletions
    expect(t.flagged.map((f) => f.id)).toEqual(["m00001"]);
    expect(t.removed).toEqual([]);
    expect(t.cursor().reconciliation).toMatchObject({ stage: "enumerate", peek: "105" });
  });

  it("at most a chunk's share a look: your sends first, then the latest changes (an id changed again counts as late); the look still moves on", async () => {
    let history: unknown[] = [];
    const t = listing({ history: () => ({ historyId: history.length ? "105" : "100", history }) });
    await t.pass();
    t.stored.add("self");
    // 300 stored messages changed, m00000 first and again last; 40 changes of messages not stored don't take a share
    const ids = Array.from({ length: 300 }, (_, i) => `m${String(i).padStart(5, "0")}`);
    for (const id of ids) t.stored.add(id);
    history = [relabeled([...ids, ...Array.from({ length: 40 }, (_, i) => `elsewhere${i}`), "m00000"]), added(["self"])];
    await t.pass();
    const read = t.flagged.map((f) => f.id);
    expect(read).toHaveLength(250);
    expect(read[0]).toBe("self");
    expect(read).toContain("m00000");
    expect(read).toContain("m00299");
    expect(read).not.toContain("m00051");
    expect(t.cursor().reconciliation).toMatchObject({ peek: "105" });
  });

  it("a label read or its write that fails leaves the look where it was: the next pass reads it again", async () => {
    let history: unknown[] = [];
    let status: number | undefined;
    const t = listing({ history: () => ({ historyId: history.length ? "105" : "100", history }), minimalStatus: () => status });
    await t.pass();
    history = [relabeled(["m00001"])];
    status = 400;
    await expect(t.pass()).rejects.toThrow();
    expect(t.cursor().reconciliation).not.toHaveProperty("peek");
    status = undefined;
    const update = t.sink.updateFlags;
    t.sink.updateFlags = async () => { throw new Error("synthetic write failure"); };
    await expect(t.pass()).rejects.toThrow("synthetic write failure");
    expect(t.cursor().reconciliation).not.toHaveProperty("peek");
    t.sink.updateFlags = update;
    await t.pass();
    expect(t.flagged.map((f) => f.id)).toEqual(["m00001"]);
    expect(t.cursor().reconciliation).toMatchObject({ peek: "105" });
  });

  // plan 260 (Codex critique): a message named without a change type may be an arrival the look can't place; the catch-up
  // must still start at the baseline, so the look can't move the refresh's cut past it
  it.each(["repeated page", "too many references", "a message with no change type"] as const)("history the look can't finish (%s) starts it again from now, not the same history every chunk", async (kind) => {
    let history = false;
    const t = listing({
      historyId: () => (history ? "300" : "100"),
      history: (url) => {
        if (!history) return { historyId: "100" };
        if (kind === "a message with no change type") return { historyId: "105", history: [{ messages: [{ id: "m-arrived" }] }] };
        if (kind === "repeated page") return { historyId: "105", history: [relabeled(["m00001"])], nextPageToken: "again" };
        // 2,000 references a page (the most a page holds), six pages: past what a look reads
        const page = Number(url.searchParams.get("pageToken") ?? 0);
        return { historyId: "105", history: Array.from({ length: 4 }, () => relabeled(Array.from({ length: 500 }, (_, i) => `x${page}-${i}`))), nextPageToken: String(page + 1) };
      },
    });
    await t.pass();
    history = true;
    await t.pass();
    expect(t.cursor().reconciliation).toMatchObject({ stage: "enumerate", peek: "300", gap: true });
  });
});
