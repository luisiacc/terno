// Plan 259 stage 2b: the Graph provider's writes against a synthetic Graph (test/microsoft.fixture.ts): flags, moves and
// their answers, JSON batches (a partial failure, a throttled request inside one, a lost answer), folder changes with a
// lost answer, sendMail, the large-file draft path, and interruptions on both sides of the submission.
import { afterEach, describe, expect, it } from "vitest";
import { LEAVE_FOLDER, MOVE_TO_FOLDER, type FlagUpdate, type IncomingMessage, type MessagePlacement } from "@terno/store";
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

async function setup(o: { requests?: AccountRequests; largeAttachmentBytes?: number; uploadPieceBytes?: number; sendTimeoutMs?: number; rewrite?: (url: string, body: unknown) => unknown } = {}) {
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
  const provider = createGraphApiProvider(ctx, {
    endpoints: ms.endpoints(), tokens: { get: async () => token, invalidate() {} }, requestsPerSecond: Infinity, userFoldersEveryMs: 0,
    buildRaw: (payload) => buildRaw(payload, { keepBcc: true }),
    largeAttachmentBytes: o.largeAttachmentBytes, uploadPieceBytes: o.uploadPieceBytes, sendTimeoutMs: o.sendTimeoutMs,
  });
  let ops = 0;
  const t = {
    ms, rows, byId, placements, provider, store,
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

  it("trash, spam, not spam and back to the Inbox move as IMAP's do: your own mail never to Junk, Sent and Drafts never to the Inbox", async () => {
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
    expect([inbox, filed, sent, draft].map((id) => t.ms.messages.get(id)!.folder)).toEqual(["inbox-id", "inbox-id", "sent-id", "drafts-id"]);
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

  it("with a large file: a draft from the MIME without it, an upload session in order with no Authorization, then the draft's send", async () => {
    const t = await setup({ largeAttachmentBytes: 5000, uploadPieceBytes: 3000 });
    t.ms.uploadMin = 5000;
    const order: string[] = [];
    t.ms.onRequest = (path) => { if (path.endsWith("/send")) order.push("send"); };
    await t.provider.execute({ id: "s1", kind: "send", target: {}, payload: payload({ attachments: [file("big.bin", 7000, 0x62), file("small.txt", 100)] }), beforeSubmission: async () => { order.push("before"); } });
    expect(order).toEqual(["before", "send"]);
    expect(t.ms.sent).toHaveLength(1);
    const sent = t.ms.sent[0]!;
    expect(sent.via).toBe("draft");
    expect(sent.mime).toContain("small.txt");
    expect(sent.mime).not.toContain("big.bin");
    expect(sent.files).toEqual([expect.objectContaining({ name: "big.bin", size: 7000 })]);
    expect(sent.files[0]!.bytes.equals(Buffer.alloc(7000, 0x62))).toBe(true);
    expect(t.ms.uploads.map((u) => u.range)).toEqual(["bytes 0-2999/7000", "bytes 3000-5999/7000", "bytes 6000-6999/7000"]);
    expect(t.ms.uploadAuthorized).toBe(0);
    expect(t.ms.inFolder("sentitems")).toHaveLength(1);
    expect(t.ms.inFolder("drafts")).toHaveLength(0);
  });

  it("interrupted before the submission (an upload): retryable, the draft goes, nothing sent; after it (the draft's send): unknown", async () => {
    const t = await setup({ largeAttachmentBytes: 5000, uploadPieceBytes: 3000 });
    t.ms.uploadMin = 5000;
    let puts = 0;
    t.ms.lose = (request) => request === "PUT /upload" && ++puts === 2 ? "after" : undefined;
    const before = await t.provider.execute({ id: "s1", kind: "send", target: {}, payload: payload({ attachments: [file("big.bin", 7000)] }) }).catch((e: unknown) => e);
    expect(before).toMatchObject({ retryable: true, ambiguous: false });
    expect(t.ms.sent).toEqual([]);
    expect(t.ms.inFolder("drafts")).toEqual([]);
    t.ms.lose = null;
    await t.provider.execute({ id: "s1", kind: "send", target: {}, payload: payload({ attachments: [file("big.bin", 7000)] }) });
    expect(t.ms.sent).toHaveLength(1);
    t.ms.lose = (request) => /^POST \/me\/messages\/[^/]+\/send$/.test(request) ? "after" : undefined;
    const after = await t.provider.execute({ id: "s2", kind: "send", target: {}, payload: payload({ messageId: "m2@x", attachments: [file("big.bin", 7000)] }) }).catch((e: unknown) => e);
    expect(after).toMatchObject({ ambiguous: true, retryable: false });
    expect(t.ms.sent).toHaveLength(2);
    // beforeSubmission refusing (the send was cancelled meanwhile) sends nothing and leaves no draft
    t.ms.lose = null;
    await expect(t.provider.execute({ id: "s3", kind: "send", target: {}, payload: payload({ messageId: "m3@x", attachments: [file("big.bin", 7000)] }), beforeSubmission: async () => { throw new ProviderError("cancelled", false); } })).rejects.toThrow("cancelled");
    expect(t.ms.sent).toHaveLength(2);
    expect(t.ms.inFolder("drafts")).toEqual([]);
  });

  it("refuses an upload URL anywhere but outlook.office.com or Graph's own root", async () => {
    const t = await setup({ largeAttachmentBytes: 5000, uploadPieceBytes: 3000, rewrite: (url, body) => url.endsWith("/createUploadSession") ? { ...(body as object), uploadUrl: "https://upload.example.test/session" } : body });
    t.ms.uploadMin = 5000;
    await expect(t.provider.execute({ id: "s1", kind: "send", target: {}, payload: payload({ attachments: [file("big.bin", 7000)] }) })).rejects.toMatchObject({ i18n: { key: "errors.outlook.invalidResponse" } });
    expect(t.ms.uploads).toEqual([]);
    expect(t.ms.sent).toEqual([]);
  });
});
