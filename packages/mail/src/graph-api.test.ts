// Plan 259 stage 2a: the Graph provider's read side against a synthetic Graph (test/microsoft.fixture.ts).
import { afterEach, describe, expect, it } from "vitest";
import type { FlagUpdate, IncomingMessage, ProviderFolder } from "@terno/store";
import { createNodeIncomingProcessor } from "../../backend/src/incoming-worker";
import { createGraphApiProvider, GRAPH_CONCURRENCY, GraphApiError, graphSearch, type GraphTokenSource } from "./graph-api";
import { IncomingPipeline } from "./incoming";
import { requestHttp } from "./provider-http";
import { SyntheticMicrosoft } from "./test/microsoft.fixture";
import { type AccountRequests, type MailProvider, type Observation429, type ProviderContext, type SyncSink } from "./types";

interface Row { id: number; providerMsgId: string; folder: string | null; inInbox: boolean; isTrash: boolean; isSpam: boolean; isSent: boolean; isDraft: boolean; isRead: boolean; isStarred: boolean; subject: string; text: string | null; date: number; threadId: string | null; size: number }

/** What a store keeps of the provider's word: rows by Graph id, the flags and folder updateFlags and ingest write. */
function memoryStore() {
  const rows = new Map<string, Row>();
  const byId = new Map<number, Row>();
  let next = 1;
  return {
    rows, byId,
    ingest(messages: IncomingMessage[]) {
      for (const m of messages) {
        const existing = rows.get(m.providerMsgId!);
        const fields = { inInbox: m.inInbox, isTrash: m.isTrash, isSpam: m.isSpam, isSent: m.isSent, isDraft: m.isDraft, isRead: m.isRead, isStarred: m.isStarred, ...(m.folder !== undefined && { folder: m.folder }) };
        if (existing) { Object.assign(existing, fields); continue; }
        const row: Row = { id: next++, providerMsgId: m.providerMsgId!, folder: null, subject: m.subject, text: m.bodyText, date: m.date, threadId: m.providerThreadId, size: m.size, ...fields };
        rows.set(row.providerMsgId, row);
        byId.set(row.id, row);
      }
    },
    updateFlags(updates: FlagUpdate[]) {
      for (const u of updates) {
        const row = byId.get(u.messageId);
        if (!row || row.providerMsgId !== u.expectedProviderMsgId) continue;
        Object.assign(row, u.flags);
        if (u.folder !== undefined) row.folder = u.folder;
      }
    },
    remove(ids: number[]) {
      for (const id of ids) { const row = byId.get(id); if (row) { byId.delete(id); rows.delete(row.providerMsgId); } }
    },
  };
}

const opened: { close(): Promise<void> }[] = [];
afterEach(async () => { for (const o of opened.splice(0).reverse()) await o.close(); });

async function setup(o: {
  pageSize?: number; flagObservation?: boolean; requests?: AccountRequests; snapshots?: () => { id: number; providerMsgId: string }[];
  /** a JSON answer as the provider will see it (a test reshapes Graph's) */
  rewrite?: (url: string, body: unknown) => unknown;
  tokens?: GraphTokenSource;
  /** an answer of the test's own in place of Graph's */
  respond?: (url: string) => Response | undefined;
  pendingAttachments?: () => { id: number; providerMsgId: string }[];
  /** Graph ids with a pending capture repair (retired ones leave it) */
  repairs?: Set<string>;
} = {}) {
  const ms = await new SyntheticMicrosoft().start();
  const processor = createNodeIncomingProcessor();
  const incoming = new IncomingPipeline(processor);
  const db = memoryStore();
  let cursor: unknown = null;
  const ingested: { id: string; live: boolean }[] = [];
  const removed: string[] = [];
  const folders: ProviderFolder[][] = [];
  const fetched: string[] = [];
  const pages: (string | undefined)[] = [];
  const backfilled: unknown[] = [];
  const folderPages: string[] = [];
  const retired: string[] = [];
  let again = 0, saves = 0;
  const token = ms.accessToken();
  const ctx = {
    incoming, incomingProcessor: processor,
    account: { id: 1, kind: "outlook", email: "ana@contoso.com" }, config: {},
    ...(o.flagObservation && { flagObservation: true }),
    ...(o.requests && { requests: o.requests }),
    store: {
      messageByProviderId: async (id: string) => { const row = db.rows.get(id); return row ? { id: row.id, subject: row.subject, fromEmail: "", isDraft: !!row.isDraft } : null; },
      folderMessagePage: async (folder: string, after = 0) => {
        folderPages.push(folder);
        const rows = [...db.byId.values()].filter((r) => r.folder === folder && r.id > after).sort((a, b) => a.id - b.id).slice(0, 50);
        return { items: rows.map((r) => ({ id: r.id, providerMsgId: r.providerMsgId })), ...(rows.length === 50 && { next: rows.at(-1)!.id }) };
      },
      syncedMessagePage: async (after?: string) => {
        pages.push(after);
        const keys = [...db.rows.keys()].sort().filter((k) => after === undefined || k > after).slice(0, 50);
        return { items: keys.map((k) => ({ id: db.rows.get(k)!.id, providerMsgId: k })), ...(keys.length && { next: keys.at(-1) }) };
      },
      pendingFlagSnapshots: async () => {
        const items = o.snapshots?.() ?? [];
        return { items, throughMessageId: items.at(-1)?.id ?? 0, hasMore: false };
      },
      pendingAttachmentBodies: async () => o.pendingAttachments?.() ?? [],
      ...(o.repairs && { repairs: {
        get: async (_account: number, locator: { kind: string; providerId?: string }) => locator.kind === "outlook" && o.repairs!.has(locator.providerId!) ? { state: "pending", revision: 1, locator } : null,
        list: async () => ({ items: [...o.repairs!].map((providerId) => ({ state: "pending", revision: 1, locator: { kind: "outlook", providerId } })) }),
      } }),
    },
    loadCursor: async () => structuredClone(cursor),
    saveCursor: async (value: unknown) => { saves++; cursor = structuredClone(value); },
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      if (o.requests) throw new Error("a provider with a request policy fetches through it");
      fetched.push(String(input));
      const own = o.respond?.(String(input));
      if (own) return own;
      const response = await fetch(input, init);
      if (!o.rewrite || !response.headers.get("content-type")?.includes("application/json")) return response;
      return Response.json(o.rewrite(String(input), await response.json()), { status: response.status });
    },
  } as unknown as ProviderContext;
  const signal = new AbortController();
  const sink: SyncSink = {
    signal: signal.signal, windowStart: 0,
    async ingest(messages, opts) {
      db.ingest(messages);
      for (const m of messages) ingested.push({ id: m.providerMsgId!, live: opts?.live === true });
    },
    async updateFlags(updates) { db.updateFlags(updates); },
    async removeMessages(ids) { for (const id of ids) removed.push(db.byId.get(id)!.providerMsgId); db.remove(ids); },
    async setBody() {}, async setSyncState() {}, async pendingMessageIds() { return new Set(); },
    async setFolders(list) { folders.push([...list]); },
    again() { again++; },
    async backfillDone(request) { backfilled.push(request); },
    async retireCapture(locator) { if (locator.kind === "outlook") { retired.push(locator.providerId); o.repairs?.delete(locator.providerId); } },
  };
  const make = () => createGraphApiProvider(ctx, { endpoints: ms.endpoints(), tokens: o.tokens ?? { get: async () => token, invalidate() {} }, requestsPerSecond: Infinity, pageSize: o.pageSize, userFoldersEveryMs: 0 });
  const t = {
    ms, db, ingested, removed, folders, ctx, sink, fetched, backfilled, pages, folderPages, retired,
    get saves() { return saves; },
    provider: make(),
    get cursor() { return cursor as { folders: Record<string, Record<string, unknown>>; refresh?: unknown } | null; },
    get again() { return again; },
    /** a new provider, as a restart makes (nothing in memory carried over) */
    async restart() { await t.provider.close(); t.provider = make(); },
    sync: (extra: Partial<SyncSink> = {}) => t.provider.sync({ ...sink, ...extra }),
    row: (id: string) => db.rows.get(id),
    async close() { await t.provider.close(); await processor.close(); incoming.close(); await ms.stop(); },
  };
  opened.push(t);
  return t;
}

/** a message nested `levels` multiparts deep */
function deep(levels: number): string {
  let part = "Content-Type: text/plain\r\n\r\ntext";
  for (let i = levels; i > 0; i--) part = `Content-Type: multipart/mixed; boundary="b${i}"\r\n\r\n--b${i}\r\n${part}\r\n--b${i}--`;
  return `Subject: Deep\r\nMIME-Version: 1.0\r\n${part}`;
}

const reads = (ms: SyntheticMicrosoft, id: string) => ms.graphUrls.filter((u) => u.startsWith(`/v1.0/me/messages/${encodeURIComponent(id)}?`)).length;

describe("Graph provider: the first sync", () => {
  it("reads each synced folder's first delta round (the window's filter), keeping its deltaLink; the folder list is the person's own, nested, without system folders", async () => {
    const t = await setup({ pageSize: 2 });
    const clients = t.ms.folder("Clients");
    const sub = t.ms.folder("Receipts", "inbox-id");
    t.ms.folders.set("search-id", { id: "search-id", displayName: "Unread", parentFolderId: "root-id", searchFolder: true });
    const ids = {
      a: t.ms.deliver("inbox-id", { subject: "First", received: Date.parse("2026-11-01T10:00:00Z") }),
      b: t.ms.deliver("inbox-id", { subject: "Second", isRead: true, flag: "flagged", received: Date.parse("2026-11-02T10:00:00Z") }),
      c: t.ms.deliver("inbox-id", { subject: "Third", received: Date.parse("2026-11-03T10:00:00Z") }),
      sent: t.ms.deliver("sent-id", { from: "ana@contoso.com", subject: "Mine" }),
      client: t.ms.deliver(clients, { subject: "Client" }),
      receipt: t.ms.deliver(sub, { subject: "Receipt" }),
      junk: t.ms.deliver("junk-id", { subject: "Spam" }),
      trash: t.ms.deliver("trash-id", { subject: "Old" }),
      draft: t.ms.deliver("drafts-id", { subject: "Draft", isDraft: true }),
      outbox: t.ms.deliver("outbox-id", { subject: "Leaving" }),
    };
    await t.sync();
    // every message where it is, with its flags and its one folder (a role folder has none)
    expect(t.row(ids.a)).toMatchObject({ inInbox: true, isRead: false, isStarred: false, folder: null, subject: "First", threadId: null, date: Date.parse("2026-11-01T10:00:00Z") });
    expect(t.row(ids.a)!.text).toContain("Body 1");
    expect(t.row(ids.b)).toMatchObject({ inInbox: true, isRead: true, isStarred: true });
    expect(t.row(ids.sent)).toMatchObject({ isSent: true, inInbox: false, folder: null });
    expect(t.row(ids.client)).toMatchObject({ inInbox: false, folder: clients });
    expect(t.row(ids.receipt)).toMatchObject({ inInbox: false, folder: sub });
    expect(t.row(ids.junk)).toMatchObject({ isSpam: true, inInbox: false });
    expect(t.row(ids.trash)).toMatchObject({ isTrash: true });
    expect(t.row(ids.draft)).toMatchObject({ isDraft: true });
    expect(t.row(ids.outbox)).toBeUndefined();
    // a first sync notifies nothing
    expect(t.ingested.every((m) => !m.live)).toBe(true);
    // the person's folders: one under the Inbox shows at the top; no search folder, no Outbox
    expect(t.folders.at(-1)).toEqual([{ key: clients, path: ["Clients"], selectable: true }, { key: sub, path: ["Receipts"], selectable: true }]);
    // the window's filtered delta first, paged by nextLink to its deltaLink, then the window listed (nothing new in it)
    const inbox = t.ms.graphUrls.filter((u) => u.startsWith("/v1.0/me/mailFolders/inbox-id/messages"));
    const round = inbox.filter((u) => u.includes("/delta?"));
    expect(decodeURIComponent(round[0]!)).toContain("$filter=receivedDateTime ge 1970-01-01T00:00:00Z");
    expect(round.slice(1, -1).every((u) => u.includes("$skiptoken="))).toBe(true);
    // the round after the listing goes on from the kept deltaLink
    expect(round.at(-1)).toContain("$deltatoken=");
    const listed = inbox.findIndex((u) => u.includes("/messages?"));
    expect(listed).toBeGreaterThan(inbox.findIndex((u) => u.includes("/delta?") && !u.includes("$skiptoken=") && !u.includes("$deltatoken=")));
    expect(listed).toBeLessThan(inbox.length - 1);
    expect(Object.values(t.cursor!.folders).every((s) => typeof s.delta === "string" && (s.delta as string).includes("$deltatoken=") && !s.initial && !s.list)).toBe(true);
    expect(Object.keys(t.cursor!.folders).sort()).toEqual(["archive-id", "drafts-id", "inbox-id", "junk-id", "sent-id", "trash-id", clients, sub].sort());
    // every call asked for immutable ids
    expect(t.ms.missingPrefer).toEqual([]);
    // nothing was downloaded twice
    expect(t.ms.graphUrls.filter((u) => u.endsWith("/$value"))).toHaveLength(9);
  });

  it("a quiet pass is one delta request a folder, and a quick check one request in all", async () => {
    const t = await setup();
    const clients = t.ms.folder("Clients");
    t.ms.deliver("inbox-id");
    t.ms.deliver(clients);
    await t.sync();
    const before = t.ms.graphUrls.length;
    await t.sync();
    const pass = t.ms.graphUrls.slice(before);
    expect(pass.every((u) => u.includes("/messages/delta?$deltatoken="))).toBe(true);
    expect(pass).toHaveLength(7);
    const quick = t.ms.graphUrls.length;
    await t.sync({ quick: true });
    expect(t.ms.graphUrls.slice(quick)).toEqual([expect.stringMatching(/^\/v1\.0\/me\/mailFolders\/inbox-id\/messages\/delta\?\$deltatoken=/)]);
    expect(t.again).toBe(0);
  });

  it("a quick check before any first sync asks for an ordinary pass and reads nothing", async () => {
    const t = await setup();
    await t.sync({ quick: true });
    expect(t.again).toBe(1);
    expect(t.ms.graphUrls).toEqual([]);
  });
});

describe("Graph provider: deltas", () => {
  it("new mail in the Inbox past a saved round notifies; elsewhere it's stored quietly; read and flag changes from elsewhere land", async () => {
    const t = await setup();
    const old = t.ms.deliver("inbox-id");
    await t.sync();
    const fresh = t.ms.deliver("inbox-id", { subject: "New" });
    const mine = t.ms.deliver("sent-id", { subject: "Sent elsewhere" });
    t.ms.setRead(old, true);
    t.ms.setFlag(old, "flagged");
    await t.sync();
    expect(t.ingested.filter((m) => m.id === fresh)).toEqual([{ id: fresh, live: true }]);
    expect(t.ingested.filter((m) => m.id === mine)).toEqual([{ id: mine, live: false }]);
    expect(t.row(old)).toMatchObject({ isRead: true, isStarred: true, inInbox: true });
    // a quick check brings the next arrival, live
    const quick = t.ms.deliver("inbox-id");
    await t.sync({ quick: true });
    expect(t.ingested.filter((m) => m.id === quick)).toEqual([{ id: quick, live: true }]);
  });

  it("delta pages follow nextLink and save each page's place only after its effects", async () => {
    const t = await setup({ pageSize: 2 });
    t.ms.deliver("inbox-id");
    await t.sync();
    const ids = Array.from({ length: 5 }, () => t.ms.deliver("inbox-id"));
    const saves: unknown[] = [];
    const save = t.ctx.saveCursor;
    t.ctx.saveCursor = async (value, check) => { saves.push(structuredClone((value as { folders: Record<string, unknown> }).folders["inbox-id"])); await save(value, check); };
    await t.sync();
    expect(ids.every((id) => t.row(id))).toBe(true);
    const inbox = (saves.filter((s) => s !== undefined) as { delta: string }[]).filter((s, i, all) => i === 0 || s.delta !== all[i - 1]!.delta);
    // two nextLinks (pages of 2) then the deltaLink
    expect(inbox.map((s) => s.delta.includes("$skiptoken=") ? "next" : "delta")).toEqual(["next", "next", "delta"]);
  });

  it("a page whose message fails on its own content holds the folder's place (read again next pass); a repair the store records lets it go on", async () => {
    const t = await setup();
    await t.sync();
    const id = t.ms.deliver("inbox-id");
    // nested past the parser's depth (64): the message's own verdict
    t.ms.messages.get(id)!.mime = deep(70);
    const place = t.cursor!.folders["inbox-id"]!.delta;
    await expect(t.sync()).rejects.toMatchObject({ reason: "mime-depth" });
    expect(t.cursor!.folders["inbox-id"]!.delta).toBe(place);
    const blocked: unknown[] = [];
    await t.sync({ blockCapture: async (locator, reason, revision) => { blocked.push([locator, reason, revision]); } });
    expect(blocked).toEqual([[{ kind: "outlook", providerId: id }, "mime-depth", 0]]);
    expect(t.row(id)).toBeUndefined();
    expect(t.cursor!.folders["inbox-id"]!.delta).not.toBe(place);
  });
});

describe("Graph provider: Codex code review of stage 2a", () => {
  it("#1: a message deleted while a first sync reads its folder goes on the next pass (the round's link was kept first)", async () => {
    const t = await setup({ pageSize: 1 });
    t.ms.deliver("inbox-id", { received: Date.now() - 2000 });
    t.ms.deliver("inbox-id", { received: Date.now() - 1000 });
    let gone: string | undefined;
    t.ms.onRequest = (url) => {
      if (gone || !url.includes("$skiptoken=")) return;
      gone = [...t.db.rows.keys()][0];
      if (gone) t.ms.destroy(gone);
    };
    await t.sync();
    expect(gone).toBeDefined();
    t.ms.onRequest = null;
    await t.sync();
    expect(t.removed).toEqual([gone]);
  });

  it("#1 (round 2 #1): after its first round a folder lists the rest of the window, newest first (Graph's 5,000 cut it here), then goes on by delta", async () => {
    const t = await setup({ pageSize: 2 });
    t.ms.deltaCap = 2;
    const ids = Array.from({ length: 5 }, (_, i) => t.ms.deliver("inbox-id", { received: Date.UTC(2026, 10, 1 + i) }));
    await t.sync();
    expect(ids.every((id) => t.row(id))).toBe(true);
    const listing = t.ms.graphUrls.filter((u) => u.startsWith("/v1.0/me/mailFolders/inbox-id/messages?"));
    expect(decodeURIComponent(listing[0]!)).toContain("$orderby=receivedDateTime desc&$top=2");
    expect(t.cursor!.folders["inbox-id"]!.list).toBeUndefined();
    // what's stored isn't downloaded twice
    expect(t.ms.graphUrls.filter((u) => u.endsWith("/$value"))).toHaveLength(5);
    const late = t.ms.deliver("inbox-id");
    await t.sync();
    expect(t.ingested.filter((m) => m.id === late)).toEqual([{ id: late, live: true }]);
  });

  it("#2: a new message whose delta entries are a full one then a sparse one, or a sparse one alone, is still downloaded", async () => {
    let shape: "duplicate" | "sparse" = "duplicate";
    let target: string | undefined;
    const t = await setup({
      rewrite: (url, body) => {
        if (!target || !url.includes("/messages/delta") || !url.includes("$deltatoken=")) return body;
        const page = body as { value: Record<string, unknown>[] };
        const full = page.value.find((v) => v.id === target);
        if (!full) return body;
        page.value = shape === "duplicate" ? [...page.value, { id: target, isRead: true }] : page.value.map((v) => v.id === target ? { id: target, isRead: true } : v);
        return page;
      },
    });
    t.ms.deliver("inbox-id");
    await t.sync();
    target = t.ms.deliver("inbox-id");
    await t.sync();
    expect(t.row(target)).toMatchObject({ isRead: true });
    shape = "sparse";
    target = t.ms.deliver("inbox-id");
    await t.sync();
    expect(t.row(target)).toBeDefined();
  });

  it("#3: a mailbox Graph refuses (MailboxNotEnabledForRESTAPI) removes nothing", async () => {
    let targets: { id: number; providerMsgId: string }[] = [];
    const t = await setup({ flagObservation: true, snapshots: () => targets.splice(0) });
    const a = t.ms.deliver("inbox-id");
    await t.sync();
    t.ms.mailbox = false;
    targets = [{ id: t.row(a)!.id, providerMsgId: a }];
    await expect(t.sync()).rejects.toMatchObject({ status: 404, codes: ["MailboxNotEnabledForRESTAPI"] });
    expect(t.removed).toEqual([]);
    expect(t.row(a)).toBeDefined();
  });

  it("#4: a folder deleted for good drops its place and what Terno had of it, read again by id", async () => {
    const t = await setup();
    const clients = t.ms.folder("Clients");
    const filed = t.ms.deliver(clients), kept = t.ms.deliver("inbox-id");
    await t.sync();
    t.ms.deleteFolder(clients);
    await t.sync();
    expect(t.removed).toEqual([filed]);
    expect(t.row(kept)).toBeDefined();
    expect(t.cursor!.folders[clients]).toBeUndefined();
    expect(t.cursor!.refresh).toBeUndefined();
  });

  it("#5: an old message moved into the Inbox is stored quietly; only new mail notifies", async () => {
    const t = await setup();
    const old = t.ms.deliver("outbox-id", { received: Date.now() - 21 * 86_400_000 });
    await t.sync();
    t.ms.move(old, "inbox-id");
    const fresh = t.ms.deliver("inbox-id");
    await t.sync();
    expect(t.ingested.filter((m) => m.id === old)).toEqual([{ id: old, live: false }]);
    expect(t.ingested.filter((m) => m.id === fresh)).toEqual([{ id: fresh, live: true }]);
  });

  it("#6: mail a widened window brought in is tracked by the deltas after (each folder starts again from the wider window)", async () => {
    const t = await setup();
    const now = Date.now();
    const recent = now - 30 * 86_400_000;
    const older = t.ms.deliver("inbox-id", { received: now - 60 * 86_400_000 });
    t.ms.deliver("inbox-id", { received: now - 86_400_000 });
    await t.sync({ windowStart: recent });
    expect(t.row(older)).toBeUndefined();
    const request = { since: now - 90 * 86_400_000, until: recent };
    await t.sync({ windowStart: request.since, backfill: request });
    expect(t.row(older)).toBeDefined();
    expect(t.backfilled).toEqual([request]);
    // deleted between the old links' last round and the new ones' first: the restart's reconciliation finds it (round 2 #2)
    const lost = [...t.db.rows.keys()].find((id) => id !== older)!;
    t.ms.destroy(lost);
    await t.sync({ windowStart: request.since });
    expect(t.removed).toEqual([lost]);
    // a flag change on it: outside the old filter, Graph wouldn't say (only read states and removals cross it)
    t.ms.setFlag(older, "flagged");
    await t.sync({ windowStart: request.since });
    expect(t.row(older)).toMatchObject({ isStarred: true });
  });

  it("#7: a stored message missing its attachments that's gone on Graph goes here, so the rest of the list comes next", async () => {
    const t = await setup({ pendingAttachments: () => [...t.db.rows.values()].filter((r) => r.subject.startsWith("Pending")).map((r) => ({ id: r.id, providerMsgId: r.providerMsgId })) });
    const gone = t.ms.deliver("inbox-id", { subject: "Pending gone" });
    const kept = t.ms.deliver("inbox-id", { subject: "Pending kept" });
    await t.sync();
    t.ms.messages.delete(gone);
    const downloads = t.ms.graphUrls.filter((u) => u.endsWith(`${encodeURIComponent(kept)}/$value`)).length;
    await t.sync();
    expect(t.removed).toEqual([gone]);
    expect(t.ms.graphUrls.filter((u) => u.endsWith(`${encodeURIComponent(kept)}/$value`)).length).toBeGreaterThan(downloads);
  });

  it("#10: a search Graph's 1,000 cut short (all of them newer than asked) is partial", async () => {
    const t = await setup();
    const now = Date.now();
    for (let i = 0; i < 1001; i++) t.ms.deliver("inbox-id", { subject: `Invoice ${i}`, received: now + 10_000 + i });
    const result = await t.provider.search!({ queries: [{ terms: ["invoice"] }], before: now, limit: 250, signal: new AbortController().signal });
    expect(result).toEqual({ hits: [], partial: true });
  });
});

describe("Graph provider: Codex code review of stage 2a, round 2", () => {
  it("#3: a 404 whose body says nothing (no error code) removes nothing", async () => {
    let targets: { id: number; providerMsgId: string }[] = [];
    let silent: string | undefined;
    const t = await setup({ flagObservation: true, snapshots: () => targets.splice(0), respond: (url) => silent && url.includes(`/me/messages/${encodeURIComponent(silent)}?`) ? new Response("", { status: 404 }) : undefined });
    const a = t.ms.deliver("inbox-id");
    await t.sync();
    silent = a;
    targets = [{ id: t.row(a)!.id, providerMsgId: a }];
    await expect(t.sync()).rejects.toMatchObject({ status: 404, codes: [] });
    expect(t.removed).toEqual([]);
  });

  it("#4: a reconciliation asked for again while one runs keeps its place and starts over once it ends", async () => {
    const t = await setup();
    t.ms.deliver("inbox-id");
    await t.sync();
    const at = [...t.db.rows.keys()][0]!;
    t.ctx.loadCursor = (async () => ({ ...t.cursor, refresh: { after: at } })) as typeof t.ctx.loadCursor;
    t.ms.expireDelta("inbox-id");
    await t.sync();
    // the one under way went on from its place, then the new one from the top
    expect(t.pages).toEqual([at, undefined, at]);
    expect(t.cursor!.refresh).toBeUndefined();
  });

  it("#10: an undated Inbox entry the read finds in another folder is stored there, quietly", async () => {
    let target: string | undefined;
    const t = await setup({
      rewrite: (url, body) => {
        if (!target || !url.includes("/mailFolders/inbox-id/messages/delta") || !url.includes("$deltatoken=")) return body;
        (body as { value: unknown[] }).value.push({ id: target, isRead: true });
        return body;
      },
    });
    t.ms.deliver("inbox-id");
    await t.sync();
    target = t.ms.deliver("archive-id", { received: Date.now() });
    await t.sync();
    expect(t.ingested.filter((m) => m.id === target)).toEqual([{ id: target, live: false }]);
    expect(t.row(target)).toMatchObject({ inInbox: false, folder: null });
  });

  it("#12: a deltaLink off Graph's root is never kept: the place stays where it was", async () => {
    let poison = false;
    const t = await setup({
      rewrite: (url, body) => {
        if (!poison || !url.includes("/mailFolders/inbox-id/messages/delta")) return body;
        const page = body as Record<string, unknown>;
        if (page["@odata.deltaLink"]) page["@odata.deltaLink"] = "https://elsewhere.example/v1.0/me/x?$deltatoken=y";
        return page;
      },
    });
    t.ms.deliver("inbox-id");
    await t.sync();
    const place = t.cursor!.folders["inbox-id"]!.delta;
    poison = true;
    await expect(t.sync()).rejects.toMatchObject({ i18n: { key: "errors.outlook.invalidResponse" } });
    expect(t.cursor!.folders["inbox-id"]!.delta).toBe(place);
  });

  it("#6: an undated change to a message outside the window is read once, not at every change", async () => {
    let old: string | undefined;
    const t = await setup({
      rewrite: (url, body) => {
        if (!old || !url.includes("/messages/delta")) return body;
        const page = body as { value: Record<string, unknown>[] };
        page.value = page.value.map((v) => v.id === old ? { id: old, isRead: v.isRead } : v);
        return page;
      },
    });
    const windowStart = Date.now() - 86_400_000;
    old = t.ms.deliver("inbox-id", { received: Date.now() - 30 * 86_400_000 });
    await t.sync({ windowStart });
    t.ms.setRead(old, true);
    await t.sync({ windowStart });
    t.ms.setRead(old, false);
    await t.sync({ windowStart });
    expect(t.row(old)).toBeUndefined();
    expect(reads(t.ms, old)).toBe(1);
  });
});

describe("Graph provider: a message leaving a folder (revision 4)", () => {
  it("moved from the Inbox to a folder read after it: the Inbox's @removed is read by id and placed; nothing is removed", async () => {
    const t = await setup();
    const clients = t.ms.folder("Clients");
    const id = t.ms.deliver("inbox-id");
    await t.sync();
    t.ms.move(id, clients);
    await t.sync();
    expect(t.removed).toEqual([]);
    expect(t.row(id)).toMatchObject({ inInbox: false, folder: clients });
    expect(reads(t.ms, id)).toBe(1);
  });

  it("moved from a folder to the Inbox (read before it): the folder's @removed needs no read, the Inbox already placed it", async () => {
    const t = await setup();
    const clients = t.ms.folder("Clients");
    const id = t.ms.deliver(clients);
    await t.sync();
    t.ms.move(id, "inbox-id");
    await t.sync();
    expect(t.removed).toEqual([]);
    expect(t.row(id)).toMatchObject({ inInbox: true, folder: null });
    expect(reads(t.ms, id)).toBe(0);
  });

  it("across a restart between the two folders' reads: still placed, never removed", async () => {
    const t = await setup();
    const clients = t.ms.folder("Clients");
    const id = t.ms.deliver("inbox-id");
    await t.sync();
    t.ms.move(id, clients);
    // the pass stops after the Inbox (Clients' delta refused), then the app restarts
    t.ms.throttle = { status: 503, match: new RegExp(`/mailFolders/${clients}/messages/delta`), times: 1 };
    await expect(t.sync()).rejects.toBeInstanceOf(GraphApiError);
    expect(t.row(id)).toMatchObject({ folder: clients });
    await t.restart();
    await t.sync();
    expect(t.removed).toEqual([]);
    expect(t.row(id)).toMatchObject({ inInbox: false, folder: clients });
  });

  it("deleted for good: the @removed's read is a 404, and it goes here too; moved somewhere Terno doesn't sync, the same", async () => {
    const t = await setup();
    const a = t.ms.deliver("inbox-id"), b = t.ms.deliver("inbox-id");
    await t.sync();
    t.ms.destroy(a);
    t.ms.move(b, "outbox-id");
    await t.sync();
    expect(t.removed.sort()).toEqual([a, b].sort());
  });
});

describe("Graph provider: an expired delta", () => {
  for (const expiry of ["gone", "syncStateNotFound"] as const) {
    it(`${expiry === "gone" ? "410 Gone" : "syncStateNotFound"} lists the folder again and reads every stored message again by id: what went meanwhile goes`, async () => {
      const t = await setup();
      const keep = t.ms.deliver("inbox-id"), lost = t.ms.deliver("inbox-id");
      await t.sync();
      t.ms.expiry = expiry;
      t.ms.expireDelta("inbox-id");
      t.ms.destroy(lost);
      t.ms.setRead(keep, true);
      const arrived = t.ms.deliver("inbox-id");
      await t.sync();
      // the reconciliation: every stored message read by id; the gone one goes, the other takes its state
      expect(t.removed).toEqual([lost]);
      expect(t.row(keep)).toMatchObject({ isRead: true });
      expect(t.cursor!.refresh).toBeUndefined();
      expect(t.cursor!.folders["inbox-id"]).toMatchObject({ initial: true });
      expect(t.cursor!.folders["inbox-id"]!.delta).toBeUndefined();
      expect(t.again).toBe(1);
      // the next pass reads a new first round (what's stored isn't downloaded again)
      const downloads = t.ms.graphUrls.filter((u) => u.endsWith("/$value")).length;
      await t.sync();
      expect(t.row(arrived)).toBeDefined();
      expect(t.ms.graphUrls.filter((u) => u.endsWith("/$value")).length - downloads).toBe(1);
      expect(t.cursor!.folders["inbox-id"]!.delta).toEqual(expect.stringContaining("$deltatoken="));
    });
  }
});

describe("Graph provider: requests", () => {
  it(`never more than ${GRAPH_CONCURRENCY} at once against the mailbox`, async () => {
    const t = await setup();
    for (let i = 0; i < 12; i++) t.ms.deliver("inbox-id");
    let release!: () => void;
    t.ms.valueGate = new Promise<void>((resolve) => { release = resolve; });
    const pass = t.sync();
    await expect.poll(() => t.ms.graphUrls.filter((u) => u.endsWith("/$value")).length).toBe(GRAPH_CONCURRENCY);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(t.ms.graphUrls.filter((u) => u.endsWith("/$value")).length).toBe(GRAPH_CONCURRENCY);
    release();
    await pass;
    expect(t.ms.maxInflight).toBe(GRAPH_CONCURRENCY);
    expect([...t.db.rows.keys()]).toHaveLength(12);
  });

  it("a 429, and a 503 with a Retry-After, go to the request policy's ledger with their wait, and the provider doesn't retry by itself", async () => {
    const observed: Observation429[] = [];
    const policy = {
      check() {}, accessAvailable() {}, tokenUnavailable() {}, close() {},
      reserve: (d: { request: import("./types").HttpRequestContext }) => ({ request: d.request, dispatch: (transport: () => Promise<Response>) => transport(), headers429: async (o: Observation429) => { observed.push(o); return "committed" as const; }, headers() {}, release() {} }),
    };
    let proofs = 0;
    const requests: AccountRequests = {
      generation: () => 1, check() {}, tokenUnavailable() {}, accessAvailable() {},
      async prove(read) { proofs++; expect(await read()).toBe("ana@contoso.com"); },
      request: (descriptor, input, init) => requestHttp(policy, descriptor, () => fetch(input, init), Date.now),
    };
    const t = await setup({ requests });
    t.ms.deliver("inbox-id");
    t.ms.throttle = { status: 429, retryAfter: "7", match: /\/mailFolders\/inbox-id\/messages\/delta\?/, times: 1 };
    const error = await t.sync().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GraphApiError);
    expect(error).toMatchObject({ status: 429, retryable: true });
    expect(observed).toHaveLength(1);
    expect(observed[0]!.minimum).toMatchObject({ kind: "at", basis: "delay" });
    expect(t.ms.graphUrls.filter((u) => u.startsWith("/v1.0/me/mailFolders/inbox-id/messages/delta?"))).toHaveLength(1);
    t.ms.throttle = { status: 503, retryAfter: "3", match: /\/mailFolders\/inbox-id\/messages\/delta\?/, times: 1 };
    await expect(t.sync()).rejects.toMatchObject({ status: 503, retryable: true });
    expect(observed).toHaveLength(2);
    await t.sync();
    expect(t.db.rows.size).toBe(1);
    // the mailbox is proven through /me before mail is read
    expect(proofs).toBeGreaterThan(0);
  });

  it("refuses a link that leaves Graph's own root, absolute or a relative one that climbs out (Codex code review #8)", async () => {
    const t = await setup();
    t.ms.deliver("inbox-id");
    await t.sync();
    for (const delta of ["https://elsewhere.example/v1.0/me/mailFolders/inbox-id/messages/delta?$deltatoken=x", "/%2e%2e/beta/me/messages", "/../../beta/me/messages"]) {
      t.ctx.loadCursor = async <T,>() => ({ v: 1, folders: { "inbox-id": { after: 0, startedAt: 0, delta } } }) as T;
      const before = t.fetched.length;
      await expect(t.sync()).rejects.toMatchObject({ i18n: { key: "errors.outlook.invalidResponse" } });
      expect(t.fetched.slice(before).some((u) => u.includes("elsewhere") || u.includes("/beta/"))).toBe(false);
    }
  });

  it("holds a slot until a 401's answer is over: renewals never put a fifth request on the mailbox (Codex code review #11)", async () => {
    let bad = GRAPH_CONCURRENCY;
    const t = await setup({ tokens: { get: async () => bad-- > 0 ? "access-stale" : good, invalidate() {} } });
    const good = t.ms.accessToken();
    let release!: () => void;
    t.ms.unauthorizedGate = new Promise<void>((resolve) => { release = resolve; });
    t.ms.deliver("inbox-id");
    const pass = t.sync();
    await expect.poll(() => t.ms.maxInflight).toBe(GRAPH_CONCURRENCY);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(t.ms.maxInflight).toBe(GRAPH_CONCURRENCY);
    release();
    await pass;
    expect(t.ms.maxInflight).toBe(GRAPH_CONCURRENCY);
    expect(t.db.rows.size).toBe(1);
  });
});

describe("Graph provider: flag snapshots, bodies, search", () => {
  it("answers flag snapshots by a targeted read: flags and folder as the server has them, and a 404 removes", async () => {
    let targets: { id: number; providerMsgId: string }[] = [];
    const t = await setup({ flagObservation: true, snapshots: () => targets.splice(0) });
    const clients = t.ms.folder("Clients");
    const a = t.ms.deliver("inbox-id"), b = t.ms.deliver("inbox-id");
    await t.sync();
    t.ms.messages.get(a)!.folder = clients;
    t.ms.messages.get(a)!.isRead = true;
    t.ms.messages.get(a)!.flag = "flagged";
    t.ms.messages.delete(b);
    targets = [{ id: t.row(a)!.id, providerMsgId: a }, { id: t.row(b)!.id, providerMsgId: b }];
    await t.sync();
    expect(t.row(a)).toMatchObject({ folder: clients, inInbox: false, isRead: true, isStarred: true });
    expect(t.removed).toEqual([b]);
    expect(decodeURIComponent(t.ms.graphUrls.find((u) => u.startsWith(`/v1.0/me/messages/${encodeURIComponent(a)}?`))!)).toContain("$select=id,receivedDateTime,isRead,isDraft,flag,parentFolderId");
  });

  it("reads a body by id with its credit, and a message gone answers null", async () => {
    const t = await setup();
    const id = t.ms.deliver("inbox-id", { body: "The whole text" });
    const body = await t.provider.readBody!({ id: 1, providerMsgId: id }, new AbortController().signal);
    expect(body!.parsed.text).toContain("The whole text");
    body!.release();
    expect(await t.provider.readBody!({ id: 2, providerMsgId: "AAMkGone=" }, new AbortController().signal)).toBeNull();
  });

  it("searches Graph's $search, honours before and the limit, skips what's stored, and fetches hits as old mail", async () => {
    const t = await setup();
    const clients = t.ms.folder("Clients");
    const now = Date.now();
    const stored = t.ms.deliver("inbox-id", { subject: "Invoice March", received: now - 1000 });
    await t.sync();
    const older = t.ms.deliver(clients, { subject: "Invoice January", received: now - 90 * 86_400_000 });
    const newest = t.ms.deliver("inbox-id", { subject: "Invoice today", received: now + 10_000 });
    t.ms.deliver("inbox-id", { subject: "Lunch", received: now - 5000 });
    const outbox = t.ms.deliver("outbox-id", { subject: "Invoice draft", received: now - 7000 });
    const signal = new AbortController().signal;
    const result = await t.provider.search!({ queries: [{ terms: ["invoice"] }], before: now, limit: 10, signal });
    expect(result.hits.map((h) => h.id).sort()).toEqual([older, outbox].sort());
    expect(result.hits.find((h) => h.id === older)!.date).toBe(now - 90 * 86_400_000);
    expect(t.ms.graphUrls.some((u) => u.includes(stored))).toBe(false);
    expect((await t.provider.search!({ queries: [{ terms: ["invoice"] }], before: now, limit: 1, signal })).hits).toHaveLength(1);
    void newest;
    await t.provider.fetchHits!(result.hits, t.sink);
    expect(t.row(older)).toMatchObject({ folder: clients });
    // one in a folder Terno doesn't sync isn't stored
    expect(t.row(outbox)).toBeUndefined();
    expect(t.ingested.filter((m) => m.id === older)).toEqual([{ id: older, live: false }]);
  });

  it("builds KQL from a query's words only", () => {
    expect(graphSearch({ terms: ["quarterly report"], from: "ana@contoso.com", subject: 'Q3 "final"', anyOf: [["pdf", "xlsx"]], hasAttachment: true }))
      .toBe("quarterly report (pdf OR xlsx) from:ana@contoso.com subject:Q3 subject:final hasAttachments:true");
    expect(graphSearch({ terms: ["a AND b", "c)"] })).toBe("a b c");
  });
});

describe("Graph provider: review round 3", () => {
  it("#2: a draft another app edits, then sends, is read again whole each time (the Sent copy keeps the draft's id)", async () => {
    const t = await setup();
    const draft = t.ms.deliver("drafts-id", { subject: "Plan", body: "first words", isDraft: true });
    await t.sync();
    expect(t.row(draft)).toMatchObject({ isDraft: true, subject: "Plan" });
    t.ms.edit(draft, { subject: "Plan v2", body: "second words" });
    await t.sync();
    expect(t.row(draft)).toMatchObject({ isDraft: true, subject: "Plan v2" });
    expect(t.row(draft)!.text).toContain("second words");
    t.ms.edit(draft, { subject: "Plan final", body: "what went", isDraft: false, from: "ana@contoso.com" }, "sent-id");
    await t.sync();
    expect(t.row(draft)).toMatchObject({ isDraft: false, isSent: true, subject: "Plan final", folder: null });
    expect(t.row(draft)!.text).toContain("what went");
    // nothing about it notifies, and a message that isn't a draft is never read again for a change
    expect(t.ingested.filter((m) => m.id === draft).every((m) => !m.live)).toBe(true);
    const downloads = t.ms.graphUrls.filter((u) => u.endsWith(`${encodeURIComponent(draft)}/$value`)).length;
    t.ms.setFlag(draft, "flagged");
    await t.sync();
    expect(t.ms.graphUrls.filter((u) => u.endsWith(`${encodeURIComponent(draft)}/$value`))).toHaveLength(downloads);
    expect(t.row(draft)).toMatchObject({ isStarred: true });
  });

  it("#6: a repair whose message is now where Terno doesn't sync is retired, never read again each pass", async () => {
    const repairs = new Set<string>();
    const t = await setup({ repairs });
    const away = t.ms.deliver("outbox-id");
    repairs.add(away);
    await t.sync();
    expect(t.retired).toEqual([away]);
    const reads = t.ms.graphUrls.filter((u) => u.includes(encodeURIComponent(away))).length;
    await t.sync();
    expect(t.ms.graphUrls.filter((u) => u.includes(encodeURIComponent(away)))).toHaveLength(reads);
  });

  it("#7: the folder list a folder change read is used, but the next pass reads and stores it again", async () => {
    const t = await setup();
    await t.sync();
    const lists = t.folders.length;
    const made = await t.provider.createFolder!({ parent: null, name: "Projects", folders: [] });
    // the host's write of this list failed: the pass after the change still reads it and hands it over
    await t.sync();
    expect(t.folders.length).toBe(lists + 1);
    expect(t.folders.at(-1)!.map((f) => f.key)).toContain(made.key);
  });

  it("#8: a search by dates alone (mail from last February) asks Graph for those dates, newest first", async () => {
    const t = await setup();
    const day = 86_400_000, now = Date.now();
    const inside = t.ms.deliver("inbox-id", { received: now - 300 * day });
    t.ms.deliver("inbox-id", { received: now - 400 * day });
    t.ms.deliver("inbox-id", { received: now - 10 * day });
    const result = await t.provider.search!({ queries: [{ terms: [], after: now - 330 * day, before: now - 280 * day }], before: now - 30 * day, limit: 50, signal: new AbortController().signal });
    expect(result).toEqual({ hits: [{ id: inside, date: now - 300 * day }], partial: false });
    const asked = decodeURIComponent(t.ms.graphUrls.find((u) => u.startsWith("/v1.0/me/messages?"))!);
    expect(asked).toContain("$orderby=receivedDateTime desc");
    expect(asked).toContain("receivedDateTime ge ");
    // nothing to search by at all is still no request
    const count = t.ms.graphUrls.length;
    expect(await t.provider.search!({ queries: [{ terms: ["((("] }], before: now, limit: 50, signal: new AbortController().signal })).toEqual({ hits: [], partial: false });
    expect(t.ms.graphUrls).toHaveLength(count);
  });

  it("#9: a quiet pass saves the cursor once, not once a folder", async () => {
    const t = await setup();
    for (let i = 0; i < 5; i++) t.ms.deliver(t.ms.folder(`F${i}`));
    await t.sync();
    const saves = t.saves;
    await t.sync();
    expect(t.saves - saves).toBe(1);
    // a change in one folder is saved with its round, and the quiet ones once after the sweep
    t.ms.deliver("inbox-id");
    const next = t.saves;
    await t.sync();
    expect(t.saves - next).toBe(2);
  });

  it("Fable #1: a folder inside Deleted Items or Junk Email is neither listed nor synced; one Outlook deletes into Deleted Items goes", async () => {
    const t = await setup();
    const old = t.ms.folder("Old project", "trash-id"), junkSub = t.ms.folder("Caught", "junk-id"), live = t.ms.folder("Live");
    const gone = t.ms.deliver(old), caught = t.ms.deliver(junkSub), kept = t.ms.deliver(live);
    await t.sync();
    expect(t.folders.at(-1)!.map((f) => f.key)).toEqual([live]);
    expect(t.row(gone)).toBeUndefined();
    expect(t.row(caught)).toBeUndefined();
    expect(t.row(kept)).toMatchObject({ folder: live });
    // Outlook's own delete: the folder moves under Deleted Items
    t.ms.folders.get(live)!.parentFolderId = "trash-id";
    // the list is read again (a quarter-hour on, or a launch)
    await t.restart();
    await t.sync();
    expect(t.folders.at(-1)).toEqual([]);
    expect(t.row(kept)).toBeUndefined();
  });

  it("Fable #3: a folder that went is read again by its own messages only, never the whole account", async () => {
    const t = await setup();
    const clients = t.ms.folder("Clients");
    const filed = t.ms.deliver(clients);
    for (let i = 0; i < 5; i++) t.ms.deliver("inbox-id");
    await t.sync();
    t.ms.folders.get(clients)!.parentFolderId = "outbox-id";
    await t.restart();
    await t.sync();
    expect(t.folderPages).toEqual([clients]);
    expect(t.pages).toEqual([]);
    expect(t.removed).toEqual([filed]);
    expect(t.cursor).not.toHaveProperty("left");
    expect(t.cursor!.refresh).toBeUndefined();
  });

  it("Fable #5: a folder Graph refuses (403) is that folder's: the others still sync, and the pass then says so", async () => {
    let refuse: string | undefined;
    const t = await setup({ respond: (url) => refuse && url.includes(`/mailFolders/${encodeURIComponent(refuse)}/messages`) ? Response.json({ error: { code: "ErrorAccessDenied" } }, { status: 403 }) : undefined });
    const a = t.ms.folder("A"), b = t.ms.folder("B");
    await t.sync();
    refuse = a;
    const later = t.ms.deliver(b);
    await expect(t.sync()).rejects.toMatchObject({ status: 403 });
    expect(t.row(later)).toMatchObject({ folder: b });
  });
});

describe("Graph provider: the account", () => {
  it("verify reads /me; a token Graph refuses twice is a sign-in, never a retry", async () => {
    const t = await setup();
    await t.provider.verify();
    let invalidated = 0;
    const p: MailProvider = createGraphApiProvider(t.ctx, { endpoints: t.ms.endpoints(), tokens: { get: async () => "access-unknown", invalidate() { invalidated++; } }, requestsPerSecond: Infinity });
    const error = await p.verify().catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "ProviderAuthError", i18n: { key: "errors.microsoft.revoked" } });
    expect(invalidated).toBe(2);
    await p.close();
  });
});
