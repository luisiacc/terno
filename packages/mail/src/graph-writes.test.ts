// Plan 259 stage 2b: the Graph provider's writes against a synthetic Graph (test/microsoft.fixture.ts): flags, moves and
// their answers, JSON batches (a partial failure, a throttled request inside one, a lost answer), folder changes with a
// lost answer, sendMail, the large-file draft path, and interruptions on both sides of the submission.
import { afterEach, describe, expect, it } from "vitest";
import { LEAVE_FOLDER, MOVE_TO_FOLDER, RETURN_TO, type FlagUpdate, type IncomingMessage, type MessagePlacement } from "@terno/store";
import { createNodeIncomingProcessor } from "../../backend/src/incoming-worker";
import { buildRaw } from "./compose";
import { batchThrottle, createGraphApiProvider } from "./graph-api";
import { IncomingPipeline } from "./incoming";
import { requestHttp } from "./provider-http";
import { SyntheticMicrosoft } from "./test/microsoft.fixture";
import { ProviderError, type AccountRequests, type Observation429, type ProviderContext, type ProviderOp, type SendPayload, type SyncSink } from "./types";

interface Row { id: number; providerMsgId: string; folder: string | null; inInbox: boolean; isTrash: boolean; isSpam: boolean; isRead: boolean; isStarred: boolean }

const opened: { close(): Promise<void> }[] = [];
afterEach(async () => { for (const o of opened.splice(0).reverse()) await o.close(); });

async function setup(o: { requests?: AccountRequests; writeMaxBytes?: number; quota?: import("./gmail-quota").QuotaPacer; uploadPieceBytes?: number; sendTimeoutMs?: number; readTimeoutMs?: number; rewrite?: (url: string, body: unknown) => unknown; delay?: (url: string, method: string) => number } = {}) {
  const ms = await new SyntheticMicrosoft().start();
  const processor = createNodeIncomingProcessor();
  const incoming = new IncomingPipeline(processor);
  const rows = new Map<string, Row>();
  const byId = new Map<number, Row>();
  let next = 1;
  /** a row for a Graph id, as a sync would have stored it */
  const store = (graphId: string, fields: Partial<Row> = {}) => {
    const row: Row = { id: next++, providerMsgId: graphId, folder: null, inInbox: true, isTrash: false, isSpam: false, isRead: false, isStarred: false, ...fields };
    rows.set(graphId, row);
    byId.set(row.id, row);
    return row.id;
  };
  const placements: MessagePlacement[][] = [];
  let cursor: unknown = null;
  const token = ms.accessToken();
  const invalidated: string[] = [];
  const ctx = {
    incoming, incomingProcessor: processor,
    account: { id: 1, kind: "outlook", email: "ana@contoso.com" }, config: {},
    ...(o.requests && { requests: o.requests }),
    store: {
      messageByProviderId: async (id: string) => { const row = rows.get(id); return row ? { id: row.id, subject: "", fromEmail: "" } : null; },
      syncedMessagePage: async () => ({ items: [] }),
      pendingFlagSnapshots: async () => ({ items: [], throughMessageId: 0, hasMore: false }),
      pendingAttachmentBodies: async () => [],
      providerIds: async (ids: readonly number[]) => new Map(ids.flatMap((id) => byId.has(id) ? [[id, byId.get(id)!.providerMsgId] as const] : [])),
      placeMessages: async (list: readonly MessagePlacement[]) => {
        placements.push([...list]);
        for (const p of list) { const row = byId.get(p.messageId); if (row && row.providerMsgId === p.providerMsgId) row.folder = p.folder; }
        return [];
      },
    },
    loadCursor: async () => structuredClone(cursor),
    saveCursor: async (value: unknown) => { cursor = structuredClone(value); },
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const wait = o.delay?.(String(input), init?.method ?? "GET") ?? 0;
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      const response = await fetch(input, init);
      if (!o.rewrite || !response.headers.get("content-type")?.includes("application/json")) return response;
      return Response.json(o.rewrite(String(input), await response.json()), { status: response.status });
    },
  } as unknown as ProviderContext;
  const sink: SyncSink = {
    signal: new AbortController().signal, windowStart: 0,
    async ingest(messages: IncomingMessage[]) {
      for (const m of messages) {
        const fields = { inInbox: m.inInbox, isTrash: m.isTrash, isSpam: m.isSpam, isRead: m.isRead, isStarred: m.isStarred, ...(m.folder !== undefined && { folder: m.folder }) };
        const existing = rows.get(m.providerMsgId!);
        if (existing) Object.assign(existing, fields);
        else store(m.providerMsgId!, fields);
      }
    },
    async updateFlags(updates: FlagUpdate[]) {
      for (const u of updates) {
        const row = byId.get(u.messageId);
        if (!row || row.providerMsgId !== u.expectedProviderMsgId) continue;
        Object.assign(row, u.flags);
        if (u.folder !== undefined) row.folder = u.folder;
      }
    },
    async removeMessages(ids) { for (const id of ids) { const row = byId.get(id); if (row) { byId.delete(id); rows.delete(row.providerMsgId); } } },
    async setBody() {}, async setSyncState() {}, async pendingMessageIds() { return new Set(); },
    async setFolders() {},
  };
  const make = () => createGraphApiProvider(ctx, {
    endpoints: ms.endpoints(), tokens: { get: async () => token, invalidate(t) { invalidated.push(t); } }, requestsPerSecond: Infinity, userFoldersEveryMs: 0,
    buildRaw: (payload) => buildRaw(payload, { keepBcc: true }),
    writeMaxBytes: o.writeMaxBytes, uploadPieceBytes: o.uploadPieceBytes, sendTimeoutMs: o.sendTimeoutMs, ...(o.readTimeoutMs && { readTimeoutMs: o.readTimeoutMs }), ...(o.quota && { quota: o.quota }),
  });
  const provider = make();
  let ops = 0;
  const t = {
    ms, rows, byId, placements, provider, store, token, invalidated,
    /** a new provider, as a restart makes (nothing in memory carried over) */
    async restart() { await t.provider.close(); t.provider = make(); },
    row: (graphId: string) => rows.get(graphId)!,
    op: (kind: string, graphIds: string[], payload: unknown = null, extra: Partial<ProviderOp> = {}): ProviderOp => ({ id: `op-${++ops}`, kind, target: { messageIds: graphIds.map((g) => rows.get(g)!.id) }, payload, ...extra }),
    run: (kind: string, graphIds: string[], payload: unknown = null) => t.provider.execute(t.op(kind, graphIds, payload)),
    sync: () => t.provider.sync(sink),
    /** the moves Graph was asked for, as `id → destination` */
    moves: () => t.ms.batches.flat().filter((r) => r.method === "POST" && r.url.endsWith("/move")).map((r) => decodeURIComponent(r.url.split("/")[3]!)),
    async close() { await provider.close(); await processor.close(); incoming.close(); await ms.stop(); },
  };
  opened.push(t);
  return t;
}

const payload = (o: Partial<SendPayload> = {}): SendPayload => ({
  from: { name: "Ana", email: "ana@contoso.com" }, to: [{ name: "", email: "bo@example.test" }], cc: [], bcc: [{ name: "", email: "hidden@example.test" }],
  subject: "Hello", text: "Hi there", messageId: "m1.terno@contoso.com", inReplyTo: null, references: [], providerThreadId: null, ...o,
});

const file = (name: string, size: number, fill = 0x61) => {
  const bytes = Buffer.alloc(size, fill);
  return { assetId: `asset-${name}`, filename: name, mime: "application/octet-stream", size, dataBase64: bytes.toString("base64") };
};

describe("Graph writes: flags", () => {
  it("marks read and unread, flags and unflags, 20 a JSON batch, each request with the immutable-id header; one gone is done", async () => {
    const t = await setup();
    const ids = Array.from({ length: 22 }, () => t.ms.deliver("inbox-id"));
    for (const id of ids) t.store(id);
    t.ms.destroy(ids[3]!);
    await t.run("markRead", ids);
    expect(t.ms.batches).toHaveLength(2);
    expect(t.ms.batches.map((b) => b.length)).toEqual([20, 2]);
    expect(t.ms.batches.flat().every((r) => r.method === "PATCH")).toBe(true);
    expect(ids.filter((id) => id !== ids[3]).every((id) => t.ms.messages.get(id)!.isRead)).toBe(true);
    await t.run("markUnread", [ids[0]!]);
    expect(t.ms.messages.get(ids[0]!)!.isRead).toBe(false);
    await t.run("star", [ids[1]!]);
    expect(t.ms.messages.get(ids[1]!)!.flag).toBe("flagged");
    await t.run("unstar", [ids[1]!]);
    expect(t.ms.messages.get(ids[1]!)!.flag).toBe("notFlagged");
    expect(t.ms.batchMissingPrefer).toEqual([]);
    expect(t.ms.missingPrefer).toEqual([]);
  });

  it("review round 3 #4: Graph refusing one message never abandons the next batches; the refusal is thrown once they're done", async () => {
    const t = await setup();
    const ids = Array.from({ length: 40 }, () => t.ms.deliver("inbox-id"));
    for (const id of ids) t.store(id);
    t.ms.batchThrottle = { status: 403, match: new RegExp(`^PATCH /me/messages/${encodeURIComponent(ids[2]!)}$`), times: 1 };
    await expect(t.run("markRead", ids)).rejects.toMatchObject({ retryable: false });
    expect(t.ms.batches).toHaveLength(2);
    expect(ids.filter((id) => id !== ids[2]).every((id) => t.ms.messages.get(id)!.isRead)).toBe(true);
    // a move the same: the second batch's messages still go
    const archive = Array.from({ length: 22 }, () => t.ms.deliver("inbox-id"));
    for (const id of archive) t.store(id);
    t.ms.batchThrottle = { status: 403, match: new RegExp(`^POST /me/messages/${encodeURIComponent(archive[0]!)}/move$`), times: 1 };
    await expect(t.run("archive", archive)).rejects.toMatchObject({ retryable: false });
    expect(archive.slice(1).every((id) => t.ms.messages.get(id)!.folder === "archive-id")).toBe(true);
    // one to try again (a throttle) stops the op at once: the retry repeats it all
    const more = Array.from({ length: 22 }, () => t.ms.deliver("inbox-id"));
    for (const id of more) t.store(id);
    t.ms.batches = [];
    t.ms.batchThrottle = { status: 503, retryAfter: "1", match: new RegExp(`^PATCH /me/messages/${encodeURIComponent(more[0]!)}$`), times: 1 };
    await expect(t.run("star", more)).rejects.toMatchObject({ retryable: true });
    expect(t.ms.batches).toHaveLength(1);
  });

  it("review round 4 #7: in one batch, a refusal before a server error still leaves the op to try again: the retry marks the other message", async () => {
    const t = await setup();
    const [a, b] = [t.ms.deliver("inbox-id"), t.ms.deliver("inbox-id")];
    for (const id of [a, b]) t.store(id);
    t.ms.batchThrottles = [
      { status: 403, match: new RegExp(`^PATCH /me/messages/${encodeURIComponent(a)}$`), times: 2 },
      { status: 500, match: new RegExp(`^PATCH /me/messages/${encodeURIComponent(b)}$`), times: 1 },
    ];
    await expect(t.run("markRead", [a, b])).rejects.toMatchObject({ retryable: true });
    await expect(t.run("markRead", [a, b])).rejects.toMatchObject({ retryable: false });
    expect(t.ms.messages.get(b)!.isRead).toBe(true);
  });

  it("review round 3 #5: a request inside a batch refusing the token (401) drops it, so the retry asks for a new one", async () => {
    const t = await setup();
    const id = t.ms.deliver("inbox-id");
    t.store(id);
    t.ms.batchThrottle = { status: 401, match: /^PATCH /, times: 1 };
    await expect(t.run("markRead", [id])).rejects.toMatchObject({ retryable: true });
    expect(t.invalidated).toEqual([t.token]);
    await t.run("markRead", [id]);
    expect(t.invalidated).toEqual([t.token]);
  });

  it("plan 275: Move to Other and Move to Inbox out of it write Focused Inbox's classification, 20 a batch; Gmail's category moves are refused", async () => {
    const t = await setup();
    const ids = Array.from({ length: 21 }, () => t.ms.deliver("inbox-id"));
    for (const id of ids) t.store(id);
    await t.run("toOther", ids);
    expect(t.ms.batches.map((b) => b.length)).toEqual([20, 1]);
    expect(ids.every((id) => t.ms.messages.get(id)!.inference === "other")).toBe(true);
    await t.run("toPrimary", [ids[0]!]);
    expect(t.ms.messages.get(ids[0]!)!.inference).toBe("focused");
    expect(t.ms.batchMissingPrefer).toEqual([]);
    await expect(t.run("toPromotions", [ids[1]!])).rejects.toMatchObject({ retryable: false });
    expect(t.ms.messages.get(ids[1]!)!.inference).toBe("other");
  });

  it("plan 275: a sender override asks Graph for it (again: one already there is updated), and its undo deletes the sender's only, once gone is done", async () => {
    const t = await setup();
    const op = (kind: string, payload: unknown) => t.provider.execute({ id: kind, kind, target: { messageIds: [] }, payload });
    await op("classifySender", { address: "News@Shop.example", as: "other" });
    await op("classifySender", { address: "news@shop.example", as: "focused" });
    await op("classifySender", { address: "ana@friends.example", as: "other" });
    expect([...t.ms.overrides.values()].map((o) => [o.address.toLowerCase(), o.classifyAs])).toEqual([["news@shop.example", "focused"], ["ana@friends.example", "other"]]);
    await op("unclassifySender", { address: "news@shop.example", as: "focused", prior: null });
    expect([...t.ms.overrides.values()].map((o) => o.address)).toEqual(["ana@friends.example"]);
    await op("unclassifySender", { address: "news@shop.example", as: "focused", prior: null });
    await expect(op("classifySender", { address: "nobody", as: "other" })).rejects.toMatchObject({ retryable: false });
  });

  it("plan 275's code review #2: a sender's undo puts back the rule there before; with none before, it deletes only a rule still the action's", async () => {
    const t = await setup();
    const op = (kind: string, payload: unknown) => t.provider.execute({ id: kind, kind, target: { messageIds: [] }, payload });
    const rules = () => [...t.ms.overrides.values()].map((o) => [o.address, o.classifyAs]);
    // the person's own rule, Other; the action makes it Focused; its undo puts Other back
    await op("classifySender", { address: "news@shop.example", as: "other" });
    expect(await t.provider.senderOverride!("News@Shop.example", new AbortController().signal)).toBe("other");
    await op("classifySender", { address: "news@shop.example", as: "focused" });
    await op("unclassifySender", { address: "news@shop.example", as: "focused", prior: "other" });
    expect(rules()).toEqual([["news@shop.example", "other"]]);
    // none before: the action's goes, unless the person changed it since
    await op("classifySender", { address: "ana@friends.example", as: "other" });
    await op("classifySender", { address: "ana@friends.example", as: "focused" });
    await op("unclassifySender", { address: "ana@friends.example", as: "other", prior: null });
    expect(rules()).toEqual([["news@shop.example", "other"], ["ana@friends.example", "focused"]]);
    expect(await t.provider.senderOverride!("nobody@else.example", new AbortController().signal)).toBeNull();
  });

  it("skips a message that never reached the server (a local row) and an op with none", async () => {
    const t = await setup();
    const local = t.store("local:abc");
    await t.provider.execute({ id: "x", kind: "markRead", target: { messageIds: [local] }, payload: null });
    await t.provider.execute({ id: "y", kind: "archive", target: { messageIds: [] }, payload: null });
    expect(t.ms.batches).toEqual([]);
  });
});

describe("Graph writes: moves", () => {
  it("archives what's in the Inbox only, reading where each is first; each answer's folder is written at once", async () => {
    const t = await setup();
    const project = t.ms.folder("Project");
    const a = t.ms.deliver("inbox-id"), b = t.ms.deliver(project), c = t.ms.deliver("archive-id");
    t.store(a); t.store(b, { folder: project, inInbox: false }); t.store(c, { inInbox: false });
    await t.run("archive", [a, b, c]);
    expect(t.ms.messages.get(a)!.folder).toBe("archive-id");
    expect(t.ms.messages.get(b)!.folder).toBe(project);
    expect(t.moves()).toEqual([a]);
    // the read first, then the move
    expect(t.ms.batches.map((batch) => batch.map((r) => r.method))).toEqual([["GET", "GET", "GET"], ["POST"]]);
    expect(t.ms.batches[0]![0]!.url).toContain("$select=id,parentFolderId");
    // Archive is a role folder: no folder of its own; one already in Archive is placed there too
    expect(t.row(a).folder).toBeNull();
    expect(t.placements.flat().map((p) => p.providerMsgId).sort()).toEqual([a, c].sort());
  });

  it("trash, spam, not spam and back to the Inbox move as IMAP's do: your own mail never to Junk; back to the Inbox takes whatever the store named, your own too (review round 4)", async () => {
    const t = await setup();
    const project = t.ms.folder("Project");
    const inbox = t.ms.deliver("inbox-id"), filed = t.ms.deliver(project), sent = t.ms.deliver("sent-id"), draft = t.ms.deliver("drafts-id", { isDraft: true });
    for (const id of [inbox, filed, sent, draft]) t.store(id);
    await t.run("spam", [inbox, filed, sent]);
    expect([inbox, filed, sent].map((id) => t.ms.messages.get(id)!.folder)).toEqual(["junk-id", "junk-id", "sent-id"]);
    await t.run("notSpam", [inbox, sent]);
    expect([inbox, sent].map((id) => t.ms.messages.get(id)!.folder)).toEqual(["inbox-id", "sent-id"]);
    await t.run("trash", [inbox, sent]);
    expect([inbox, sent].map((id) => t.ms.messages.get(id)!.folder)).toEqual(["trash-id", "trash-id"]);
    t.ms.move(sent, "sent-id");
    await t.run("moveToInbox", [inbox, filed, sent, draft]);
    // the store names your own mail only when it's all a conversation has (a sent-only conversation brought back)
    expect([inbox, filed, sent, draft].map((id) => t.ms.messages.get(id)!.folder)).toEqual(["inbox-id", "inbox-id", "inbox-id", "inbox-id"]);
    expect(t.row(filed).folder).toBeNull();
  });

  it("files into a folder with one move each (no copy), and the undo takes each back where it came from", async () => {
    const t = await setup();
    const project = t.ms.folder("Project"), other = t.ms.folder("Other");
    const fromInbox = t.ms.deliver("inbox-id"), fromArchive = t.ms.deliver("archive-id"), fromOther = t.ms.deliver(other), there = t.ms.deliver(project);
    t.store(fromInbox); t.store(fromArchive, { inInbox: false }); t.store(fromOther, { folder: other, inInbox: false }); t.store(there, { folder: project, inInbox: false });
    await t.run(MOVE_TO_FOLDER, [fromInbox, fromArchive, fromOther, there], { folder: project, from: null, keepInbox: false });
    expect([fromInbox, fromArchive, fromOther, there].map((id) => t.ms.messages.get(id)!.folder)).toEqual([project, project, project, project]);
    // one already there isn't moved again
    expect(t.moves().sort()).toEqual([fromInbox, fromArchive, fromOther].sort());
    expect([fromInbox, fromArchive, fromOther, there].map((id) => t.row(id).folder)).toEqual([project, project, project, project]);
    // the undo: each group goes back to its own place (the store's journal says which)
    await t.run(LEAVE_FOLDER, [fromInbox], { folder: project, back: null, toInbox: true, stays: false });
    await t.run(LEAVE_FOLDER, [fromArchive], { folder: project, back: null, toInbox: false, stays: false, role: "archive" });
    await t.run(LEAVE_FOLDER, [fromOther], { folder: project, back: other, toInbox: false, stays: false });
    expect([fromInbox, fromArchive, fromOther].map((id) => t.ms.messages.get(id)!.folder)).toEqual(["inbox-id", "archive-id", other]);
    expect([fromInbox, fromArchive, fromOther].map((id) => t.row(id).folder)).toEqual([null, null, other]);
    // one moved elsewhere meanwhile stays where the person put it
    t.ms.move(there, other);
    await t.run(LEAVE_FOLDER, [there], { folder: project, back: null, toInbox: true, stays: false });
    expect(t.ms.messages.get(there)!.folder).toBe(other);
  });

  it("an undo (plan 259, exact undo): returnTo takes each back to Archive, Sent Items or Drafts from wherever it is, and a filing back from Deleted Items", async () => {
    const t = await setup();
    const project = t.ms.folder("Project");
    const archived = t.ms.deliver("trash-id"), own = t.ms.deliver("trash-id"), draft = t.ms.deliver("trash-id", { isDraft: true }), inbox = t.ms.deliver("inbox-id"), there = t.ms.deliver("archive-id"), filed = t.ms.deliver("trash-id");
    for (const id of [archived, own, draft, inbox, there, filed]) t.store(id);
    await t.run(RETURN_TO, [archived, inbox, there], { role: "archive" });
    await t.run(RETURN_TO, [own], { role: "sent" });
    await t.run(RETURN_TO, [draft], { role: "drafts" });
    await t.run(MOVE_TO_FOLDER, [filed], { folder: project, from: null, keepInbox: false });
    expect([archived, inbox, there, own, draft, filed].map((id) => t.ms.messages.get(id)!.folder)).toEqual(["archive-id", "archive-id", "archive-id", "sent-id", "drafts-id", project]);
    // one already there is only placed, never moved again
    expect(t.moves().sort()).toEqual([archived, inbox, own, draft, filed].sort());
    expect([archived, own, draft, filed].map((id) => t.row(id).folder)).toEqual([null, null, null, project]);
    // a role it doesn't know is refused for good
    await expect(t.run(RETURN_TO, [inbox], { role: "inbox" })).rejects.toMatchObject({ retryable: false });
  });

  it("a batch that partly fails keeps what was done, and the retry moves only what's left", async () => {
    const t = await setup();
    const project = t.ms.folder("Project");
    const ids = [t.ms.deliver("inbox-id"), t.ms.deliver("inbox-id"), t.ms.deliver("inbox-id")];
    for (const id of ids) t.store(id);
    t.ms.batchThrottle = { status: 503, match: new RegExp(`POST /me/messages/${encodeURIComponent(ids[1]!)}/move`), times: 1 };
    const failure = await t.run(MOVE_TO_FOLDER, ids, { folder: project, from: null, keepInbox: false }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ProviderError);
    expect(failure).toMatchObject({ retryable: true, ambiguous: false });
    expect(ids.map((id) => t.ms.messages.get(id)!.folder)).toEqual([project, "inbox-id", project]);
    expect(ids.map((id) => t.row(id).folder)).toEqual([project, null, project]);
    t.ms.batches = [];
    await t.run(MOVE_TO_FOLDER, ids, { folder: project, from: null, keepInbox: false });
    expect(t.moves()).toEqual([ids[1]]);
    expect(ids.map((id) => t.row(id).folder)).toEqual([project, project, project]);
  });

  it("a move whose answer was lost is retried safely: the read finds it moved and its folder is written, with no second move", async () => {
    const t = await setup();
    const project = t.ms.folder("Project");
    const id = t.ms.deliver("inbox-id");
    t.store(id);
    let batches = 0;
    t.ms.lose = (request) => request === "POST /$batch" && ++batches === 2 ? "after" : undefined;
    await expect(t.run(MOVE_TO_FOLDER, [id], { folder: project, from: null, keepInbox: false })).rejects.toMatchObject({ retryable: true, ambiguous: false });
    expect(t.ms.messages.get(id)!.folder).toBe(project);
    expect(t.row(id).folder).toBeNull();
    t.ms.lose = null;
    t.ms.batches = [];
    await t.run(MOVE_TO_FOLDER, [id], { folder: project, from: null, keepInbox: false });
    expect(t.moves()).toEqual([]);
    expect(t.row(id).folder).toBe(project);
  });

  it("what the read found already moved is written before the moves go (Codex code review #8): a lost move batch keeps it", async () => {
    const t = await setup();
    const project = t.ms.folder("Project");
    const there = t.ms.deliver(project), left = t.ms.deliver("inbox-id");
    t.store(there); t.store(left);
    let batches = 0;
    t.ms.lose = (request) => request === "POST /$batch" && ++batches === 2 ? "before" : undefined;
    await expect(t.run(MOVE_TO_FOLDER, [there, left], { folder: project, from: null, keepInbox: false })).rejects.toMatchObject({ retryable: true });
    expect(t.row(there).folder).toBe(project);
    expect(t.row(left).folder).toBeNull();
  });

  it("round 2 #5: one malformed read is that message's failure; a sibling found already moved is still written", async () => {
    let bad = "";
    const t = await setup({ rewrite: (url, body) => {
      if (!url.endsWith("/$batch") || !bad) return body;
      const value = body as { responses: { body?: { id?: string; parentFolderId?: unknown } }[] };
      for (const r of value.responses) if (r.body?.id === bad) r.body.parentFolderId = 42;
      return value;
    } });
    const project = t.ms.folder("Project");
    const there = t.ms.deliver(project), odd = t.ms.deliver("inbox-id");
    t.store(there); t.store(odd);
    bad = odd;
    await expect(t.run(MOVE_TO_FOLDER, [odd, there], { folder: project, from: null, keepInbox: false })).rejects.toMatchObject({ i18n: { key: "errors.outlook.invalidResponse" } });
    expect(t.row(there).folder).toBe(project);
  });

  it("a batch counts each request against Outlook's pace and takes as many slots as Graph runs of it (Codex code review #10)", async () => {
    const spent: number[] = [];
    const t = await setup({ quota: { async spend(units) { spent.push(units); }, charge() {} } });
    const ids = Array.from({ length: 6 }, () => t.ms.deliver("inbox-id"));
    for (const id of ids) t.store(id);
    await t.run("markRead", ids);
    expect(spent).toEqual([6]);
    // a body being read holds one of the four slots: the batch waits for all four it needs
    let open!: () => void;
    t.ms.valueGate = new Promise((resolve) => { open = resolve; });
    const reading = t.provider.readBody!({ id: t.rows.get(ids[0]!)!.id, providerMsgId: ids[0]! }, new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const marking = t.run("markUnread", ids);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(t.ms.batches).toHaveLength(1);
    open();
    (await reading)?.release();
    await marking;
    expect(t.ms.batches).toHaveLength(2);
  });

  it("a destination folder deleted meanwhile fails the op (never forgets the message); a mailbox with no Archive says so", async () => {
    const t = await setup();
    const gone = t.ms.folder("Gone");
    const id = t.ms.deliver("inbox-id");
    t.store(id);
    t.ms.deleteFolder(gone);
    await expect(t.run(MOVE_TO_FOLDER, [id], { folder: gone, from: null, keepInbox: false })).rejects.toMatchObject({ retryable: false, i18n: { key: "errors.folder.notFound" } });
    expect(t.rows.has(id)).toBe(true);
    const u = await setup();
    u.ms.folders.delete("archive-id");
    const m = u.ms.deliver("inbox-id");
    u.store(m);
    await expect(u.run("archive", [m])).rejects.toMatchObject({ retryable: false, i18n: { key: "errors.outlook.noArchive" } });
    expect(u.ms.messages.get(m)!.folder).toBe("inbox-id");
  });

  it("a move and a delta read, in both orders, end with the message in its new folder and nothing removed", async () => {
    const t = await setup();
    const project = t.ms.folder("Project");
    const a = t.ms.deliver("inbox-id"), b = t.ms.deliver("inbox-id");
    await t.sync();
    expect(t.row(a).folder).toBeNull();
    // the move first, then the delta that reports it
    await t.run(MOVE_TO_FOLDER, [a], { folder: project, from: null, keepInbox: false });
    expect(t.row(a).folder).toBe(project);
    await t.sync();
    expect(t.row(a)).toMatchObject({ folder: project, inInbox: false });
    // the delta mid-read while the move lands: whatever it wrote, the next read confirms the move
    t.ms.setRead(b, true);
    let moving: Promise<unknown> | undefined;
    t.ms.onRequest = (path) => {
      if (!moving && path.startsWith("/v1.0/me/mailFolders/inbox-id/messages/delta")) moving = t.run(MOVE_TO_FOLDER, [b], { folder: project, from: null, keepInbox: false });
    };
    await t.sync();
    await moving;
    t.ms.onRequest = null;
    await t.sync();
    expect(t.row(b)).toMatchObject({ folder: project, inInbox: false });
    expect(t.rows.has(a) && t.rows.has(b)).toBe(true);
  });
});

describe("Graph writes: batches and the ledger", () => {
  it("a throttled request inside a 200 batch reaches the request policy's ledger as a 429 does, with its wait", async () => {
    const observed: Observation429[] = [];
    const settled: string[] = [];
    const policy = {
      check() {}, accessAvailable() {}, tokenUnavailable() {}, close() {},
      reserve: (d: { request: import("./types").HttpRequestContext }) => ({ request: d.request, dispatch: (transport: () => Promise<Response>) => transport(), headers429: async (o: Observation429) => { observed.push(o); settled.push("429"); return "committed" as const; }, headers(status: number) { settled.push(String(status)); }, release() { settled.push("release"); } }),
    };
    const requests: AccountRequests = {
      generation: () => 1, check() {}, tokenUnavailable() {}, accessAvailable() {}, async prove() {},
      request: (descriptor, input, init) => requestHttp(policy, descriptor, () => fetch(input, init), Date.now),
    };
    const t = await setup({ requests });
    const id = t.ms.deliver("inbox-id");
    t.store(id);
    t.ms.batchThrottle = { status: 429, retryAfter: "7", match: /^PATCH /, times: 1 };
    const before = Date.now();
    await expect(t.run("markRead", [id])).rejects.toMatchObject({ retryable: true });
    expect(observed).toHaveLength(1);
    expect(observed[0]!.minimum).toMatchObject({ kind: "at", basis: "delay" });
    expect((observed[0]!.minimum as { atMs: number }).atMs).toBeGreaterThanOrEqual(before + 7000);
    // the ticket was held until the batch was read, then settled once and let go
    expect(settled).toEqual(["429", "release"]);
    settled.length = 0;
    await t.run("markRead", [id]);
    expect(settled).toEqual(["200", "release"]);
  });

  it("reads a throttle from any request of a batch: the longest wait, a 503 only with a Retry-After", () => {
    const now = 1_000_000;
    expect(batchThrottle({ responses: [{ id: "1", status: 200 }, { id: "2", status: 503 }] }, now)).toBeUndefined();
    const found = batchThrottle({ responses: [{ id: "1", status: 429, headers: { "Retry-After": "3" } }, { id: "2", status: 503, headers: { "retry-after": "9" } }, { id: "3", status: 429 }] }, now);
    expect(found?.minimum).toMatchObject({ kind: "at", atMs: now + 9000 });
    expect(batchThrottle({ responses: [{ id: "1", status: 429 }] }, now)?.minimum).toMatchObject({ kind: "none" });
  });
});

describe("Graph writes: folders (plan 107)", () => {
  it("creates at the top and under a folder, renames (keys kept, subfolders with it) and deletes with its subfolders", async () => {
    const t = await setup();
    const top = await t.provider.createFolder!({ parent: null, name: "Clients", folders: [] });
    expect(top.folders.find((f) => f.key === top.key)?.path).toEqual(["Clients"]);
    const child = await t.provider.createFolder!({ parent: top.key, name: "Acme", folders: [] });
    expect(child.folders.find((f) => f.key === child.key)?.path).toEqual(["Clients", "Acme"]);
    await expect(t.provider.createFolder!({ parent: null, name: "clients", folders: [] })).rejects.toMatchObject({ i18n: { key: "errors.folder.nameTaken" } });
    const renamed = await t.provider.renameFolder!({ key: top.key, name: "Customers", folders: [] });
    expect(renamed.renamed).toEqual([{ from: top.key, to: top.key }, { from: child.key, to: child.key }]);
    expect(renamed.folders.find((f) => f.key === child.key)?.path).toEqual(["Customers", "Acme"]);
    await expect(t.provider.renameFolder!({ key: "inbox-id", name: "x", folders: [] })).rejects.toMatchObject({ i18n: { key: "errors.folder.standard" } });
    const deleted = await t.provider.deleteFolder!({ key: top.key, folders: [] });
    expect(deleted.deleted.sort()).toEqual([top.key, child.key].sort());
    expect(deleted.folders).toEqual([]);
  });

  it("a change whose answer was lost is found done by reading the list again; a refusal says Graph's reason", async () => {
    const t = await setup();
    t.ms.lose = (request) => request === "POST /me/mailFolders" ? "after" : undefined;
    const created = await t.provider.createFolder!({ parent: null, name: "Lost", folders: [] });
    expect(t.ms.folders.get(created.key)?.displayName).toBe("Lost");
    t.ms.lose = (request) => request.startsWith("PATCH /me/mailFolders/") ? "after" : undefined;
    const renamed = await t.provider.renameFolder!({ key: created.key, name: "Found", folders: [] });
    expect(renamed.renamed).toEqual([{ from: created.key, to: created.key }]);
    t.ms.lose = (request) => request.startsWith("DELETE /me/mailFolders/") ? "after" : undefined;
    expect((await t.provider.deleteFolder!({ key: created.key, folders: [] })).deleted).toEqual([created.key]);
    // lost before it was made: the failure stands
    t.ms.lose = (request) => request === "POST /me/mailFolders" ? "before" : undefined;
    await expect(t.provider.createFolder!({ parent: null, name: "Never", folders: [] })).rejects.toMatchObject({ retryable: true });
    t.ms.lose = null;
    // Graph deleted it and the list can't be read after (Codex code review #9): the deletion is still reported
    const parent = await t.provider.createFolder!({ parent: null, name: "Old", folders: [] });
    const child = await t.provider.createFolder!({ parent: parent.key, name: "Older", folders: [] });
    let deleted = false;
    t.ms.lose = (request) => {
      if (request.startsWith("DELETE /me/mailFolders/")) { deleted = true; return undefined; }
      return deleted && request.startsWith("GET /me/mailFolders") ? "before" : undefined;
    };
    const gone = await t.provider.deleteFolder!({ key: parent.key, folders: [] });
    expect(gone.deleted.sort()).toEqual([parent.key, child.key].sort());
    expect(gone.folders.map((f) => f.key)).not.toContain(parent.key);
    t.ms.lose = null;
    // a name another app took between the list's read and the request: Graph's refusal, in its own words
    t.ms.onRequest = (path) => { if (path === "/v1.0/me/mailFolders" && ![...t.ms.folders.values()].some((f) => f.displayName === "Twin")) t.ms.folder("Twin"); };
    await expect(t.provider.createFolder!({ parent: null, name: "Twin", folders: [] })).rejects.toMatchObject({ retryable: false, i18n: { key: "errors.folder.refused", params: { server: "Outlook", reason: "ErrorFolderExists" } } });
  });
});

describe("Graph writes: send", () => {
  it("sends the MIME through sendMail (base64, text/plain, Bcc in the headers), with beforeSubmission right before; Sent Items gets it", async () => {
    const t = await setup();
    const order: string[] = [];
    t.ms.onRequest = (path) => { if (path === "/v1.0/me/sendMail") order.push("sendMail"); };
    const result = await t.provider.execute({ id: "s1", kind: "send", target: {}, payload: payload(), beforeSubmission: async () => { order.push("before"); } });
    expect(result).toBeUndefined();
    expect(order).toEqual(["before", "sendMail"]);
    expect(t.ms.sent).toHaveLength(1);
    expect(t.ms.sent[0]!.mime).toMatch(/^Bcc: hidden@example\.test/m);
    expect(t.ms.sent[0]!.mime).toMatch(/^Message-ID: <m1\.terno@contoso\.com>/m);
    expect(t.ms.inFolder("sentitems")).toHaveLength(1);
  });

  it("a send whose answer was lost, or that timed out, is unknown and never sent again by the provider", async () => {
    const t = await setup({ sendTimeoutMs: 300 });
    t.ms.lose = (request) => request === "POST /me/sendMail" ? "after" : undefined;
    const lost = await t.provider.execute({ id: "s1", kind: "send", target: {}, payload: payload() }).catch((e: unknown) => e);
    expect(lost).toMatchObject({ ambiguous: true, retryable: false });
    expect(t.ms.sent).toHaveLength(1);
    t.ms.lose = null;
    let open!: () => void;
    t.ms.sendGate = new Promise((resolve) => { open = resolve; });
    const slow = await t.provider.execute({ id: "s2", kind: "send", target: {}, payload: payload({ messageId: "m2@x" }) }).catch((e: unknown) => e);
    expect(slow).toMatchObject({ ambiguous: true, retryable: false });
    open();
    await new Promise((resolve) => setTimeout(resolve, 50));
    // a server error on the submission may still have sent it
    t.ms.sendGate = null;
    t.ms.throttle = { status: 503, match: /^\/v1\.0\/me\/sendMail/, times: 1 };
    await expect(t.provider.execute({ id: "s3", kind: "send", target: {}, payload: payload({ messageId: "m3@x" }) })).rejects.toMatchObject({ ambiguous: true });
    // a throttled submission was refused, not sent: safe to try again
    t.ms.throttle = { status: 429, retryAfter: "1", match: /^\/v1\.0\/me\/sendMail/, times: 1 };
    await expect(t.provider.execute({ id: "s4", kind: "send", target: {}, payload: payload({ messageId: "m4@x" }) })).rejects.toMatchObject({ ambiguous: false, retryable: true });
  });

  it("over Graph's 4 MB write limit (Codex code review #2): a draft without the files, a small file with its bytes, a large one through an upload session in order with no Authorization, then the draft's send", async () => {
    const t = await setup({ writeMaxBytes: 12_000, uploadPieceBytes: 3000 });
    t.ms.writeMax = 12_000;
    t.ms.uploadMin = 9000;
    const order: string[] = [];
    t.ms.onRequest = (path) => { if (path.endsWith("/send")) order.push("send"); };
    await t.provider.execute({ id: "s1", kind: "send", target: {}, payload: payload({ attachments: [file("big.bin", 9000, 0x62), file("small.txt", 100)] }), beforeSubmission: async () => { order.push("before"); } });
    expect(order).toEqual(["before", "send"]);
    expect(t.ms.sent).toHaveLength(1);
    const sent = t.ms.sent[0]!;
    expect(sent.via).toBe("draft");
    expect(sent.mime).not.toContain("small.txt");
    expect(sent.mime).not.toContain("big.bin");
    expect(sent.files.map((f) => [f.name, f.size])).toEqual([["big.bin", 9000], ["small.txt", 100]]);
    expect(sent.files[0]!.bytes.equals(Buffer.alloc(9000, 0x62))).toBe(true);
    expect(sent.files[1]!.bytes.equals(Buffer.alloc(100, 0x61))).toBe(true);
    expect(t.ms.uploads.map((u) => u.range)).toEqual(["bytes 0-2999/9000", "bytes 3000-5999/9000", "bytes 6000-8999/9000"]);
    expect(t.ms.uploadAuthorized).toBe(0);
    expect(t.ms.inFolder("sentitems")).toHaveLength(1);
    expect(t.ms.inFolder("drafts")).toHaveLength(0);
  });

  it("files each small enough on their own, but over the limit together, go through the draft with their bytes; one under the limit goes straight through sendMail", async () => {
    const t = await setup({ writeMaxBytes: 12_000, uploadPieceBytes: 3000 });
    t.ms.writeMax = 12_000;
    await t.provider.execute({ id: "s1", kind: "send", target: {}, payload: payload({ attachments: [file("a.bin", 3000), file("b.bin", 3000), file("c.bin", 3000)] }) });
    expect(t.ms.sent.map((s) => s.via)).toEqual(["draft"]);
    expect(t.ms.sent[0]!.files.map((f) => f.name)).toEqual(["a.bin", "b.bin", "c.bin"]);
    expect(t.ms.uploads).toEqual([]);
    await t.provider.execute({ id: "s2", kind: "send", target: {}, payload: payload({ messageId: "m2@x", attachments: [file("d.bin", 1000)] }) });
    expect(t.ms.sent.map((s) => s.via)).toEqual(["draft", "sendMail"]);
    expect(t.ms.sent[1]!.mime).toContain("d.bin");
  });

  it("a sync while the draft is still being built stores none of it (Codex code review #1); the Sent copy comes whole after", async () => {
    const t = await setup({ writeMaxBytes: 12_000, uploadPieceBytes: 3000 });
    t.ms.writeMax = 12_000;
    t.ms.uploadMin = 9000;
    await t.sync();
    let draft: string | undefined;
    await t.provider.execute({ id: "s1", kind: "send", target: {}, payload: payload({ attachments: [file("big.bin", 9000)] }), beforeSubmission: async () => {
      draft = t.ms.inFolder("drafts")[0]!.id;
      await t.sync();
      expect(t.rows.has(draft)).toBe(false);
    } });
    await t.sync();
    expect(t.rows.has(draft!)).toBe(true);
    expect(t.row(draft!)).toMatchObject({ inInbox: false, isTrash: false });
  });

  it("interrupted before the submission (an upload): retryable, the draft goes, nothing sent; after it (the draft's send): unknown; refused at it (Codex code review #5): the draft goes", async () => {
    const t = await setup({ writeMaxBytes: 12_000, uploadPieceBytes: 3000 });
    t.ms.writeMax = 12_000;
    t.ms.uploadMin = 9000;
    let puts = 0;
    t.ms.lose = (request) => request === "PUT /upload" && ++puts === 2 ? "after" : undefined;
    const before = await t.provider.execute({ id: "s1", kind: "send", target: {}, payload: payload({ attachments: [file("big.bin", 9000)] }) }).catch((e: unknown) => e);
    expect(before).toMatchObject({ retryable: true, ambiguous: false });
    expect(t.ms.sent).toEqual([]);
    expect(t.ms.inFolder("drafts")).toEqual([]);
    t.ms.lose = null;
    await t.provider.execute({ id: "s1", kind: "send", target: {}, payload: payload({ attachments: [file("big.bin", 9000)] }) });
    expect(t.ms.sent).toHaveLength(1);
    t.ms.lose = (request) => /^POST \/me\/messages\/[^/]+\/send$/.test(request) ? "after" : undefined;
    const after = await t.provider.execute({ id: "s2", kind: "send", target: {}, payload: payload({ messageId: "m2@x", attachments: [file("big.bin", 9000)] }) }).catch((e: unknown) => e);
    expect(after).toMatchObject({ ambiguous: true, retryable: false });
    expect(t.ms.sent).toHaveLength(2);
    // an unknown send's draft is left alone (it may be the message that went)
    t.ms.lose = null;
    // Graph refused the draft's send (a throttle): not sent, the draft goes, and the retry sends one
    t.ms.throttle = { status: 429, retryAfter: "1", match: /\/send$/, times: 1 };
    const drafts = t.ms.inFolder("drafts").length;
    await expect(t.provider.execute({ id: "s3", kind: "send", target: {}, payload: payload({ messageId: "m3@x", attachments: [file("big.bin", 9000)] }) })).rejects.toMatchObject({ retryable: true, ambiguous: false });
    expect(t.ms.inFolder("drafts")).toHaveLength(drafts);
    await t.provider.execute({ id: "s3", kind: "send", target: {}, payload: payload({ messageId: "m3@x", attachments: [file("big.bin", 9000)] }) });
    expect(t.ms.sent).toHaveLength(3);
    expect(t.ms.inFolder("drafts")).toHaveLength(drafts);
    // beforeSubmission refusing (the send was cancelled meanwhile) sends nothing and leaves no draft
    await expect(t.provider.execute({ id: "s4", kind: "send", target: {}, payload: payload({ messageId: "m4@x", attachments: [file("big.bin", 9000)] }), beforeSubmission: async () => { throw new ProviderError("cancelled", false); } })).rejects.toThrow("cancelled");
    expect(t.ms.sent).toHaveLength(3);
    expect(t.ms.inFolder("drafts")).toHaveLength(drafts);
  });

  it("review round 3 #3: a throttled draft send under the real request policy leaves no second draft: the DELETE the pause refused goes before the retry's draft", async () => {
    // the production order: the 429 pauses the service before the send handler sees it, so its DELETE is refused too
    let cooling = false;
    const policy = {
      check() { if (cooling) throw new ProviderError("cooling down", true); }, accessAvailable() {}, tokenUnavailable() {}, close() {},
      reserve: (d: { request: import("./types").HttpRequestContext }) => ({ request: d.request, dispatch: (transport: () => Promise<Response>) => transport(), headers429: async () => { cooling = true; return "committed" as const; }, headers() {}, release() {} }),
    };
    const requests: AccountRequests = {
      generation: () => 1, check() {}, tokenUnavailable() {}, accessAvailable() {}, async prove() {},
      request: (descriptor, input, init) => requestHttp(policy, descriptor, () => fetch(input, init), Date.now),
    };
    const t = await setup({ requests, writeMaxBytes: 12_000, uploadPieceBytes: 3000 });
    t.ms.writeMax = 12_000;
    t.ms.uploadMin = 9000;
    t.ms.throttle = { status: 429, retryAfter: "1", match: /\/send$/, times: 1 };
    const send = () => t.provider.execute({ id: "s1", kind: "send", target: {}, payload: payload({ attachments: [file("big.bin", 9000)] }) });
    await expect(send()).rejects.toMatchObject({ retryable: true, ambiguous: false });
    expect(t.ms.inFolder("drafts")).toHaveLength(1);
    cooling = false;
    // a sync before the retry stores none of it: it's still the send's
    const leftover = t.ms.inFolder("drafts")[0]!.id;
    await t.sync();
    expect(t.rows.has(leftover)).toBe(false);
    await send();
    expect(t.ms.sent).toHaveLength(1);
    expect(t.ms.inFolder("drafts")).toEqual([]);
  });

  it("review round 4 #1, #4: the draft a pause left, sent from Outlook meanwhile, is the send (never deleted, never sent twice); after a restart the retry still finds its draft by its mark", async () => {
    let cooling = false;
    const policy = {
      check() { if (cooling) throw new ProviderError("cooling down", true); }, accessAvailable() {}, tokenUnavailable() {}, close() {},
      reserve: (d: { request: import("./types").HttpRequestContext }) => ({ request: d.request, dispatch: (transport: () => Promise<Response>) => transport(), headers429: async () => { cooling = true; return "committed" as const; }, headers() {}, release() {} }),
    };
    const requests: AccountRequests = {
      generation: () => 1, check() {}, tokenUnavailable() {}, accessAvailable() {}, async prove() {},
      request: (descriptor, input, init) => requestHttp(policy, descriptor, () => fetch(input, init), Date.now),
    };
    const t = await setup({ requests, writeMaxBytes: 12_000, uploadPieceBytes: 3000 });
    t.ms.writeMax = 12_000;
    t.ms.uploadMin = 9000;
    const send = (id: string, messageId: string) => t.provider.execute({ id, kind: "send", target: {}, payload: payload({ messageId, attachments: [file("big.bin", 9000)] }) });
    // the person sends the draft the pause left, in Outlook: Terno's retry is that send
    t.ms.throttle = { status: 429, retryAfter: "1", match: /\/send$/, times: 1 };
    await expect(send("s1", "one@x")).rejects.toMatchObject({ retryable: true });
    const draft = t.ms.inFolder("drafts")[0]!.id;
    t.ms.sendDraft(draft);
    cooling = false;
    await send("s1", "one@x");
    expect(t.ms.sent).toHaveLength(1);
    expect(t.ms.messages.get(draft)).toMatchObject({ isDraft: false, folder: "sent-id" });
    // a restart forgets the draft a pause left: the retry finds it by its mark, deletes it, and sends one
    t.ms.throttle = { status: 429, retryAfter: "1", match: /\/send$/, times: 1 };
    await expect(send("s2", "two@x")).rejects.toMatchObject({ retryable: true });
    expect(t.ms.inFolder("drafts")).toHaveLength(1);
    await t.restart();
    cooling = false;
    await send("s2", "two@x");
    expect(t.ms.sent).toHaveLength(2);
    expect(t.ms.inFolder("drafts")).toEqual([]);
  });

  it("review round 4 (Fable #3): a draft send's own requests (the draft, a file with its bytes) have a send's time, not a read's", async () => {
    const t = await setup({ writeMaxBytes: 12_000, readTimeoutMs: 100, sendTimeoutMs: 10_000, delay: (url, method) => method === "POST" && /\/me\/messages(\/[^/]+\/attachments)?$/.test(new URL(url).pathname.replace(/^\/v1\.0/, "")) ? 300 : 0 });
    t.ms.writeMax = 12_000;
    await t.provider.execute({ id: "s1", kind: "send", target: {}, payload: payload({ attachments: [file("a.bin", 5000), file("b.bin", 5000)] }) });
    expect(t.ms.sent).toHaveLength(1);
    expect(t.ms.inFolder("drafts")).toEqual([]);
  });

  it("round 2: a file's own request is measured, not estimated (#8), and Graph's answer repeating its bytes is never read (#1)", async () => {
    const t = await setup({ writeMaxBytes: 12_000, uploadPieceBytes: 3000 });
    t.ms.writeMax = 12_000;
    t.ms.uploadMin = 9000;
    // 8,700 bytes: its request fits, though base64 and a 4 KiB allowance wouldn't
    await t.provider.execute({ id: "s1", kind: "send", target: {}, payload: payload({ attachments: [file("near.bin", 8700)] }) });
    expect(t.ms.sent[0]!.files.map((f) => [f.name, f.size])).toEqual([["near.bin", 8700]]);
    expect(t.ms.uploads).toEqual([]);
    const u = await setup({ writeMaxBytes: 200_000 });
    u.ms.writeMax = 200_000;
    await u.provider.execute({ id: "s2", kind: "send", target: {}, payload: payload({ attachments: [file("a.bin", 100_000), file("b.bin", 100_000)] }) });
    expect(u.ms.sent.map((s) => s.files.map((f) => f.name))).toEqual([["a.bin", "b.bin"]]);
  });

  it("round 2 #2: the Sent copy seen while the draft's send is still answering is stored (it keeps the draft's id)", async () => {
    const t = await setup({ writeMaxBytes: 12_000, uploadPieceBytes: 3000 });
    t.ms.writeMax = 12_000;
    t.ms.uploadMin = 9000;
    await t.sync();
    let open!: () => void;
    t.ms.sentGate = new Promise((resolve) => { open = resolve; });
    const sending = t.provider.execute({ id: "s1", kind: "send", target: {}, payload: payload({ attachments: [file("big.bin", 9000)] }) });
    await expect.poll(() => t.ms.sent.length).toBe(1);
    const id = t.ms.inFolder("sentitems")[0]!.id;
    await t.sync();
    open();
    await sending;
    await t.sync();
    expect(t.rows.has(id)).toBe(true);
  });

  it("refuses an upload URL anywhere but outlook.office.com or Graph's own root", async () => {
    const t = await setup({ writeMaxBytes: 12_000, uploadPieceBytes: 3000, rewrite: (url, body) => url.endsWith("/createUploadSession") ? { ...(body as object), uploadUrl: "https://upload.example.test/session" } : body });
    t.ms.writeMax = 12_000;
    t.ms.uploadMin = 9000;
    await expect(t.provider.execute({ id: "s1", kind: "send", target: {}, payload: payload({ attachments: [file("big.bin", 9000)] }) })).rejects.toMatchObject({ i18n: { key: "errors.outlook.invalidResponse" } });
    expect(t.ms.uploads).toEqual([]);
    expect(t.ms.sent).toEqual([]);
  });
});
