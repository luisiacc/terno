import "fake-indexeddb/auto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IdbMailStore } from "@terno/idb";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { IDBFactory } from "fake-indexeddb";
import { createGmailApiProvider, type ProviderContext, type ProviderRegistry } from "@terno/mail/portable";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Backend, plaintextCipher } from "./backend";
import { onSqlite } from "./test/store-axis";

const phaseOf = (value: unknown) => (value as { reconciliation?: { stage: string; baseline?: string; pages?: number } } | null)?.reconciliation;
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

async function mailbox(kind: "SQL" | "IndexedDB", retries = false) {
  const baseline = "90071992547409930000";
  let historyId = BigInt(baseline);
  const messages = new Map<string, { id: string; threadId: string; labelIds: string[]; raw: string; internalDate?: string }>();
  const history: { id: string; messagesAdded?: { message: { id: string } }[]; messagesDeleted?: { message: { id: string } }[]; labelsAdded?: { message: { id: string } }[]; labelsRemoved?: { message: { id: string } }[] }[] = [];
  let abort = new AbortController();
  const requests: URL[] = [], ingested: { id: string; live: boolean }[] = [];
  let afterIngest: (() => void | Promise<void>) | undefined;
  let afterCheckpoint: ((value: unknown) => void | Promise<void>) | undefined;
  let historyStatus = 200, rawStatus = 200, listStatus = 200;
  let nextToken = "list/+?=next", emptyFirst = false, repeatToken = false;
  const getStatuses = new Map<string, number>();
  let now = Date.now();
  let snapshot: string[] = [];
  let context: ProviderContext | undefined;
  let minimalPayload: ((payload: unknown) => unknown) | undefined;
  let historyPayload: ((payload: unknown) => unknown) | undefined;
  let holdHistory: ((send: () => void) => void) | undefined;
  // plan 229: user labels at Gmail, a label's creation that can be held, and label changes (batchModify)
  const labels = [{ id: "Label_project", name: "Project", type: "user" }];
  let holdLabel: ((send: () => void) => void) | undefined;
  const modified: { ids: string[]; add: string[]; remove: string[] }[] = [];
  const add = (id: string, record = false, thread = id) => {
    const raw = ["From: Synthetic <sender@example.test>", "To: me@example.test", `Subject: ${thread}`, `Message-ID: <${id}@example.test>`, ...(thread !== id ? [`In-Reply-To: <${thread}@example.test>`] : []),
      "MIME-Version: 1.0", 'Content-Type: multipart/mixed; boundary="b"', "", "--b", "Content-Type: text/plain", "", `Body ${id}`,
      "--b", "Content-Type: application/octet-stream", 'Content-Disposition: attachment; filename="exact.bin"', "Content-Transfer-Encoding: base64", "", "AP+ADQo=", "--b--", ""].join("\r\n");
    messages.set(id, { id, threadId: thread, labelIds: ["INBOX", "UNREAD"], raw: Buffer.from(raw).toString("base64url") });
    if (record) history.push({ id: String(++historyId), messagesAdded: [{ message: { id } }] });
  };
  const mutate = () => {
    add("arrival", true);
    messages.get("archive")!.labelIds = ["UNREAD"];
    history.push({ id: String(++historyId), labelsRemoved: [{ message: { id: "archive" } }] });
    messages.delete("deleted");
    history.push({ id: String(++historyId), messagesDeleted: [{ message: { id: "deleted" } }] });
    messages.get("read")!.labelIds = ["INBOX", "Label_project"];
    history.push({ id: String(++historyId), labelsRemoved: [{ message: { id: "read" } }] });
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://fixture.test");
    requests.push(url);
    const json = (value: unknown, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    if (url.pathname === "/profile") return json({ historyId: String(historyId), emailAddress: "me@example.test" });
    // plan 227: a send, which Gmail files as SENT (history: added)
    if (request.method === "POST" && url.pathname === "/messages/send") {
      request.resume();
      messages.set("self", { id: "self", threadId: "self", labelIds: ["SENT"], raw: "" });
      history.push({ id: String(++historyId), messagesAdded: [{ message: { id: "self" } }] });
      return json({ id: "self", threadId: "self", labelIds: ["SENT"] });
    }
    if (request.method === "POST" && (url.pathname === "/labels" || url.pathname === "/messages/batchModify")) {
      const chunks: Buffer[] = [];
      request.on("data", (c: Buffer) => chunks.push(c));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
        if (url.pathname === "/labels") {
          const send = () => { const label = { id: `Label_${labels.length}`, name: String(body.name), type: "user" }; labels.push(label); json(label); };
          const hold = holdLabel; holdLabel = undefined;
          return hold ? hold(send) : send();
        }
        const change = { ids: body.ids as string[], add: (body.addLabelIds as string[]) ?? [], remove: (body.removeLabelIds as string[]) ?? [] };
        modified.push(change);
        for (const id of change.ids) {
          const m = messages.get(id);
          if (!m) continue;
          m.labelIds = [...new Set([...m.labelIds.filter((l) => !change.remove.includes(l)), ...change.add])];
          if (change.add.length) history.push({ id: String(++historyId), labelsAdded: [{ message: { id } }] });
          if (change.remove.length) history.push({ id: String(++historyId), labelsRemoved: [{ message: { id } }] });
        }
        response.writeHead(204); response.end();
      });
      return;
    }
    if (url.pathname === "/labels") return json({ labels });
    if (url.pathname === "/messages") {
      if (!url.searchParams.has("pageToken")) snapshot = [...messages.keys()];
      const next = url.searchParams.get("pageToken");
      if (next && listStatus !== 200) return json({}, listStatus);
      if (next !== null && next !== "list/+?=next") return json({}, 400);
      return json({ historyId: "90071992547409939999", messages: (emptyFirst && !next ? [] : snapshot.slice(next ? (emptyFirst ? 0 : 3) : 0, next ? undefined : 3)).map((id) => ({ id })), ...((repeatToken || (!next && snapshot.length > 3)) && { nextPageToken: nextToken }) });
    }
    if (url.pathname === "/history") {
      if (url.searchParams.get("startHistoryId") === "1") return json({}, 404);
      if (historyStatus !== 200) return json({}, historyStatus);
      const entries = history.filter((h) => BigInt(h.id) > BigInt(url.searchParams.get("startHistoryId")!));
      const next = url.searchParams.get("pageToken");
      if (!historyPayload && next !== null && next !== "history/+?=next") return json({}, 400);
      const original = { historyId: String(historyId), history: entries.slice(next ? 2 : 0, next ? undefined : 2), ...(!next && entries.length > 2 && { nextPageToken: "history/+?=next" }) };
      const payload = historyPayload ? historyPayload(original) : original;
      const hold = holdHistory; holdHistory = undefined;
      if (hold) { hold(() => json(payload)); return; }
      return json(payload);
    }
    const id = url.pathname.replace("/messages/", "");
    if (getStatuses.has(id)) return json({}, getStatuses.get(id));
    if (id === "arrival" && rawStatus !== 200) return json({}, rawStatus);
    const message = messages.get(id);
    if (!message) return json({}, 404);
    const minimal = { id, labelIds: message.labelIds, ...(message.internalDate !== undefined && { internalDate: message.internalDate }) };
    return json(url.searchParams.get("format") === "raw" ? message : minimalPayload ? minimalPayload(minimal) : minimal);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing synthetic server port");
  const api = `http://127.0.0.1:${address.port}`;
  const dir = mkdtempSync(join(tmpdir(), "terno-gmail-catchup-"));
  const factory = new IDBFactory(), name = crypto.randomUUID();
  const platform = { uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((resolve) => setImmediate(resolve)) };
  const providers: ProviderRegistry = {
    create(ctx) {
      context = ctx;
      const provider = createGmailApiProvider({ ...ctx, saveCursor: async (value, check) => { await ctx.saveCursor(value, check); await afterCheckpoint?.(value); } }, {
        endpoints: { api }, tokens: { get: async () => "synthetic", invalidate() {} }, buildRaw: async () => new Uint8Array(),
      });
      return { ...provider, sync: (sink) => provider.sync({ ...sink, signal: AbortSignal.any([sink.signal, abort.signal]), ingest: async (batch, options) => {
        await sink.ingest(batch, options);
        ingested.push(...batch.map((m) => ({ id: m.providerMsgId!, live: options?.live === true })));
        if (ingested.length >= 3) { const hook = afterIngest; afterIngest = undefined; await hook?.(); }
      } }) };
    },
    async verifyImap() {}, async connectGmail() { throw new Error("Unused synthetic consent"); },
  };
  const open = async () => { const opened = new Backend({ dbPath: join(dir, "synthetic.db"), store: kind === "IndexedDB" ? await IdbMailStore.open({ name, factory, platform, instantSearch: false }) : undefined,
    platform, providers, now: () => now, cipher: plaintextCipher, version: "test", autoSync: retries, instantSearch: false, iconTransport: null });
    if (retries) vi.spyOn(opened.connectivity, "failed");
    return opened;
  };
  let backend = await open();
  await backend.ready;
  const { account } = await backend.store.accounts.create({ kind: "gmail", email: "me@example.test", displayName: "Synthetic", color: "brown", now: 1 });
  await (await backend.provider(account.id))!.verify();
  requests.length = 0;
  cleanup.push(async () => {
    try { await backend.stop(); }
    finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
  });
  const cursor = async () => (await backend.store.accounts.config<{ cursor?: unknown }>(account.id))?.config.cursor;
  return {
    baseline, account, requests, ingested, messages, add, mutate, cursor, get abort() { return abort; },
    get context() { return context!; },
    get retryTimer() { return backend.connectivity.failed; }, minimalPayload(hook?: (payload: unknown) => unknown) { minimalPayload = hook; },
    historyPayload(hook?: (payload: unknown) => unknown) { historyPayload = hook; },
    holdHistory(hook: (send: () => void) => void) { holdHistory = hook; },
    get backend() { return backend; }, get terminal() { return String(historyId); },
    afterIngest(hook: () => void | Promise<void>) { afterIngest = hook; }, afterCheckpoint(hook: (value: unknown) => void | Promise<void>) { afterCheckpoint = hook; },
    listStatus(status: number) { listStatus = status; }, nextToken(value: string) { nextToken = value; }, emptyFirst() { emptyFirst = true; }, repeatToken() { repeatToken = true; },
    getStatus(id: string, status: number) { if (status === 200) getStatuses.delete(id); else getStatuses.set(id, status); },
    advanceTime() { now += 86_400_000; },
    historyStatus(status: number) { historyStatus = status; }, rawStatus(status: number) { rawStatus = status; },
    seed() { for (const id of ["archive", "deleted", "read", "neighbor"]) add(id); },
    /** a second message in a conversation */
    reply(id: string, thread: string) { add(id, false, thread); },
    /** the next label creation waits at Gmail until `send` is called */
    holdLabel(hook: (send: () => void) => void) { holdLabel = hook; },
    modified,
    /** a message's labels change at Gmail (history: labels added) */
    label(id: string, labelIds: string[]) { messages.get(id)!.labelIds = labelIds; history.push({ id: String(++historyId), labelsAdded: [{ message: { id } }] }); },
    async reopen() { await backend.stop(); abort = new AbortController(); backend = await open(); await backend.ready; },
    async assertFinal() {
      const rows = (await backend.store.debug.snapshot()).messages;
      expect(rows.map((m) => m.providerMsgId).sort()).toEqual(["archive", "arrival", "neighbor", "read"]);
      expect(rows.find((m) => m.providerMsgId === "archive")).toMatchObject({ inInbox: false, isRead: false });
      expect(rows.find((m) => m.providerMsgId === "read")).toMatchObject({ inInbox: true, isRead: true, gmailLabels: JSON.stringify(["INBOX", "Label_project"]) });
      expect(rows.find((m) => m.providerMsgId === "arrival")).toMatchObject({ inInbox: true, isRead: false, bodyText: expect.stringContaining("Body arrival") });
      expect(await cursor()).toEqual({ historyId: String(historyId) });
      for (const message of rows) {
        const attachments = await backend.store.attachments.current(account.id, { id: message.id });
        expect(attachments).toHaveLength(1);
        expect(await backend.store.attachments.read(account.id, attachments[0]!.assetId!, 0)).toBe("AP+ADQo=");
      }
    },
  };
}

describe.each(["SQL", "IndexedDB"] as const)("%s public Gmail full-sync catch-up", (kind) => {
  const sqlite = onSqlite(kind);
  it.each(["before", "after"] as const)("resumes bounded cached pages after %s checkpoint failure", async (failure) => {
    const t = await mailbox(kind);
    for (let i = 0; i < 55; i++) t.add(`cached-${String(i).padStart(3, "0")}`);
    await t.backend.syncAccount(t.account.id);
    const before = (await t.backend.store.debug.snapshot()).messages;
    const store = t.backend.store.providerStore(t.account.id);
    vi.spyOn(store, "syncedMessages").mockImplementation(async () => { throw new Error("whole-account read forbidden"); });
    await t.backend.store.accounts.setCursor(t.account.id, { historyId: "1" });
    const save = t.context.saveCursor.bind(t.context);
    let failed = false;
    t.context.saveCursor = async (value, check) => {
      const phase = (value as { reconciliation?: { refreshAfter?: string } }).reconciliation;
      if (!failed && phase?.refreshAfter) {
        failed = true;
        if (failure === "after") await save(value, check);
        throw new Error("checkpoint failure");
      }
      await save(value, check);
    };
    await t.backend.syncAccount(t.account.id);
    expect(failed).toBe(true);
    const phase = (await t.cursor() as { reconciliation: { baseline: string; refreshAfter?: string } }).reconciliation;
    expect(phase.baseline).toBe(t.baseline);
    expect(phase.refreshAfter).toBe(failure === "after" ? "cached-049" : undefined);
    await t.reopen(); t.requests.length = 0;
    await t.backend.syncAccount(t.account.id);
    const minimal = t.requests.filter((url) => url.searchParams.get("format") === "minimal");
    expect(minimal).toHaveLength(failure === "after" ? 5 : 55);
    expect(await t.cursor()).toEqual({ historyId: t.baseline });
    expect((await t.backend.store.debug.snapshot()).messages).toEqual(before);
  });

  sqlite("retains automatic outage retries for an ordinary minimal GET 503", async () => {
    const t = await mailbox(kind, true); t.seed(); await t.backend.syncAccount(t.account.id);
    const old = await t.cursor();
    t.historyPayload(() => ({ historyId: t.baseline, history: [{ labelsAdded: [{ message: { id: "archive" } }] }] }));
    t.getStatus("archive", 503); await t.backend.syncAccount(t.account.id);
    expect(t.retryTimer).toHaveBeenCalledTimes(1);
    expect(await t.cursor()).toEqual(old);
  });

  sqlite.each(["minimal", "catchup"] as const)("refuses deterministic %s overflow without automatic outage retries", async (mode) => {
    const t = await mailbox(kind, true); t.seed(); await t.backend.syncAccount(t.account.id);
    const old = await t.cursor();
    if (mode === "minimal") {
      t.minimalPayload((value) => ({ ...(value as object), ignored: "x".repeat(70_000) }));
      t.historyPayload(() => ({ historyId: String(BigInt(t.baseline) + 1n), history: [{ labelsAdded: [{ message: { id: "archive" } }] }] }));
    } else t.historyPayload(() => ({ historyId: t.baseline, history: [{ labelsRemoved: Array.from({ length: 2001 }, () => ({ message: { id: "archive" } })) }] }));
    await t.backend.syncAccount(t.account.id);
    expect(t.retryTimer).not.toHaveBeenCalled();
    expect((await t.backend.store.accounts.get(t.account.id))?.syncState.lastError).toBeTruthy();
    expect(await t.cursor()).toEqual(mode === "minimal" ? old : { ...(old as object), reconciliation: { version: 1, stage: "restart" } });
    t.minimalPayload(); t.historyPayload(); await t.reopen(); await t.backend.syncAccount(t.account.id);
    expect(await t.cursor()).toEqual(old);
    expect((await t.backend.store.debug.snapshot()).messages).toHaveLength(4);
    expect(t.retryTimer).not.toHaveBeenCalled();
  });

  it("does not reinsert a message evicted while overlapping history is being read", async () => {
    const t = await mailbox(kind); t.seed(); await t.backend.syncAccount(t.account.id);
    const archived = (await t.backend.store.debug.snapshot()).messages.find((m) => m.providerMsgId === "archive")!;
    t.historyPayload(() => ({ historyId: String(BigInt(t.baseline) + 1n), history: [{ messagesAdded: [{ message: { id: "archive" } }] }] }));
    let release = () => {}, entered!: () => void;
    const held = new Promise<void>((resolve) => { entered = resolve; });
    cleanup.push(async () => { release(); });
    t.holdHistory((send) => { release = send; entered(); });
    const running = t.backend.syncAccount(t.account.id); await held;
    t.backend.evictions.begin();
    await t.backend.evictions.unit(async () => {
      await t.backend.store.sync.remove([archived.id]);
      t.backend.evictions.record([{ accountId: t.account.id, providerMsgIds: ["archive"] }]);
    });
    t.backend.evictions.end(); release(); release = () => {}; await running;
    expect((await t.backend.store.debug.snapshot()).messages.some((m) => m.providerMsgId === "archive")).toBe(false);
    await t.reopen();
    expect((await t.backend.store.debug.snapshot()).messages.some((m) => m.providerMsgId === "archive")).toBe(false);
  });

  it("replays committed 50-item flag batches after a late failure without changing identity or assets", async () => {
    const t = await mailbox(kind);
    const ids = Array.from({ length: 101 }, (_, i) => `bulk${i}`);
    for (const id of ids) t.add(id);
    await t.backend.syncAccount(t.account.id);
    const before = await t.backend.store.debug.snapshot(), old = await t.cursor();
    for (const message of t.messages.values()) message.labelIds = ["STARRED"];
    t.historyPayload(() => ({ historyId: String(BigInt(t.baseline) + 1n), history: [{ labelsRemoved: ids.map((id) => ({ message: { id } })) }] }));
    t.getStatus("bulk100", 503);
    const update = t.backend.store.sync.updateFlags;
    const writes = vi.spyOn(t.backend.store.sync, "updateFlags");
    await t.backend.syncAccount(t.account.id);
    expect(writes.mock.calls.map((c) => c[1].length)).toEqual([50, 50]);
    expect(await t.cursor()).toEqual(old);
    expect((await t.backend.store.debug.snapshot()).messages.filter((m) => m.isStarred)).toHaveLength(100);
    writes.mockRestore(); expect(t.backend.store.sync.updateFlags).toBe(update);
    t.getStatus("bulk100", 200); await t.reopen();
    await t.backend.syncAccount(t.account.id);
    const after = await t.backend.store.debug.snapshot();
    expect(after.messages.map((m) => [m.id, m.providerMsgId, m.bodyText])).toEqual(before.messages.map((m) => [m.id, m.providerMsgId, m.bodyText]));
    expect(after.messages.every((m) => m.isStarred && m.isRead && !m.inInbox)).toBe(true);
    expect(after.ops).toEqual([]);
    for (const message of after.messages) {
      const attachments = await t.backend.store.attachments.current(t.account.id, { id: message.id });
      expect(attachments).toHaveLength(1);
      expect(await t.backend.store.attachments.read(t.account.id, attachments[0]!.assetId!, 0)).toBe("AP+ADQo=");
    }
    expect(await t.cursor()).toEqual({ historyId: String(BigInt(t.baseline) + 1n) });
  });

  sqlite.each(["lateGET", "cursorAck"] as const)("replays three overlapping pages after %s with one automation and exact durable state", async (failure) => {
    const t = await mailbox(kind); t.seed(); await t.backend.syncAccount(t.account.id);
    const category = await t.backend.store.categories.create("Synthetic", "violet");
    const filter = await t.backend.store.filters.save({ name: "Arrival", enabled: true, source: "manual",
      rule: { match: "all", conditions: [{ field: "subject", op: "contains", value: "arrival" }], actions: [{ type: "addCategory", categoryId: category.id }] } }, 1);
    t.mutate();
    const old = await t.cursor();
    let page = 0;
    t.historyPayload(() => {
      const index = page++ % 3;
      return { historyId: t.terminal, ...(index < 2 && { nextPageToken: `overlap${index}` }), history: [{
        messagesAdded: [{ message: { id: "arrival" } }],
        labelsRemoved: ["read", "archive", "arrival"].map((id) => ({ message: { id } })),
        ...(index === 2 && { messagesDeleted: [{ message: { id: "deleted" } }] }),
      }] };
    });
    if (failure === "lateGET") t.getStatus("archive", 503);
    else {
      const set = t.backend.store.accounts.setCursor;
      vi.spyOn(t.backend.store.accounts, "setCursor").mockImplementation(async (...args) => { await set(...args); throw new Error("Lost cursor acknowledgement"); });
    }
    await t.backend.syncAccount(t.account.id);
    expect(await t.cursor()).toEqual(failure === "lateGET" ? old : { historyId: t.terminal });
    const arrival = (await t.backend.store.debug.snapshot()).messages.find((m) => m.providerMsgId === "arrival")!;
    expect(arrival).toBeDefined();
    expect((await t.backend.store.filters.get(filter.id))?.hits).toBe(1);
    vi.restoreAllMocks(); t.getStatus("archive", 200); page = 0;
    await t.reopen(); await t.backend.syncAccount(t.account.id); await t.assertFinal();
    const final = await t.backend.store.debug.snapshot();
    expect(final.messages.find((m) => m.providerMsgId === "arrival")?.id).toBe(arrival.id);
    expect((await t.backend.store.filters.get(filter.id))?.hits).toBe(1);
    expect(final.memberships.filter((m) => m.categoryId === category.id)).toHaveLength(1);
    expect(final.ops).toHaveLength(0);
    expect(t.ingested.filter((m) => m.id === "arrival")).toHaveLength(1);
  });

  it.each(["ingest", "flags", "remove", "cursor"] as const)("checks credential generation inside the %s store command", async (effect) => {
    const t = await mailbox(kind);
    t.seed(); await t.backend.syncAccount(t.account.id);
    const old = await t.cursor();
    t.mutate();
    let retired = false;
    const retire = async () => { if (!retired) { retired = true; await t.backend.signedIn(t.account.id); } };
    if (effect === "ingest") {
      const original = t.backend.store.sync.ingest;
      vi.spyOn(t.backend.store.sync, "ingest").mockImplementation(async (...args) => { await retire(); return original(...args); });
    } else if (effect === "flags") {
      const original = t.backend.store.sync.updateFlags;
      vi.spyOn(t.backend.store.sync, "updateFlags").mockImplementation(async (...args) => { await retire(); return original(...args); });
    } else if (effect === "remove") {
      const original = t.backend.store.sync.remove;
      vi.spyOn(t.backend.store.sync, "remove").mockImplementation(async (...args) => { await retire(); return original(...args); });
    } else {
      const original = t.backend.store.accounts.setCursor;
      vi.spyOn(t.backend.store.accounts, "setCursor").mockImplementation(async (...args) => { await retire(); return original(...args); });
    }
    await t.backend.syncAccount(t.account.id);
    expect(retired).toBe(true);
    expect(await t.cursor()).toEqual(old);
    const rows = (await t.backend.store.debug.snapshot()).messages;
    if (effect === "ingest") expect(rows.some((m) => m.providerMsgId === "arrival")).toBe(false);
    if (effect === "flags") expect(rows.find((m) => m.providerMsgId === "archive")?.inInbox).toBe(true);
    if (effect === "remove") expect(rows.some((m) => m.providerMsgId === "deleted")).toBe(true);
    vi.restoreAllMocks(); await t.reopen();
    await t.backend.syncAccount(t.account.id); await t.assertFinal();
  });

  // plan 260 (TERNO-6): a record that names messages without a change type is read by ID; it never reconciles or fails
  it("applies summary-only history by reading each message, without a reconciliation", async () => {
    const t = await mailbox(kind);
    t.seed();
    await t.backend.syncAccount(t.account.id);
    t.mutate();
    const typed = (h: Record<string, unknown>) => (["messagesAdded", "messagesDeleted", "labelsAdded", "labelsRemoved"] as const).flatMap((k) => (h[k] as { message: { id: string } }[] | undefined) ?? []).map((c) => c.message);
    t.historyPayload((page) => {
      const p = page as { history: Record<string, unknown>[] };
      return { ...p, history: p.history.map((h) => ({ id: h.id, messages: typed(h) })) };
    });
    t.requests.length = 0; t.ingested.length = 0;
    await t.backend.syncAccount(t.account.id);
    const account = await t.backend.store.accounts.get(t.account.id);
    expect(account?.syncState).toMatchObject({ status: "idle", lastError: null });
    expect(t.requests.some((r) => r.pathname === "/messages" || r.pathname === "/profile")).toBe(false);
    // what's held is read minimal; what isn't comes in whole, not as live mail (only a typed addition says it's new)
    expect(t.requests.filter((r) => r.pathname.startsWith("/messages/")).map((r) => `${r.pathname.slice(10)}:${r.searchParams.get("format")}`).sort())
      .toEqual(["archive:minimal", "arrival:minimal", "arrival:raw", "deleted:minimal", "read:minimal"]);
    expect(t.ingested).toEqual([{ id: "arrival", live: false }]);
    await t.assertFinal();
    await t.reopen();
    await t.assertFinal();
  });

  it("reads a message a typed record names without a typed change, and takes no unheld mail older than the window", async () => {
    const t = await mailbox(kind);
    t.seed();
    await t.backend.syncAccount(t.account.id);
    t.mutate();
    // Gmail has old mail this account never held (outside its window); a change to it names it, and nothing else
    t.add("old"); t.messages.get("old")!.internalDate = "86400000";
    t.historyPayload((page) => {
      const p = page as { history: Record<string, unknown>[] };
      // one typed record also names the others in `messages`, with no typed change for them
      return { ...p, history: [{ ...p.history[0], messages: [{ id: "arrival" }, { id: "archive" }, { id: "deleted" }, { id: "read" }, { id: "old" }] }] };
    });
    t.ingested.length = 0; t.requests.length = 0;
    await t.backend.syncAccount(t.account.id);
    expect((await t.backend.store.accounts.get(t.account.id))?.syncState).toMatchObject({ status: "idle", lastError: null });
    expect(t.ingested).toEqual([{ id: "arrival", live: true }]);
    // its date is read first: the old message is never downloaded (no capture, no repair)
    expect(t.requests.filter((r) => r.pathname === "/messages/old").map((r) => r.searchParams.get("format"))).toEqual(["minimal"]);
    await t.assertFinal();
  });

  it("replays summary-only history after a failure midway without a second insertion", async () => {
    const t = await mailbox(kind);
    t.seed();
    await t.backend.syncAccount(t.account.id);
    const old = await t.cursor();
    t.mutate();
    t.historyPayload((page) => {
      const p = page as { history: Record<string, unknown>[] };
      return { ...p, history: p.history.map((h) => ({ id: h.id, messages: (["messagesAdded", "messagesDeleted", "labelsAdded", "labelsRemoved"] as const).flatMap((k) => (h[k] as { message: { id: string } }[] | undefined) ?? []).map((c) => c.message) })) };
    });
    // the unheld arrival comes in, then reading a held one fails: nothing past the old cursor is claimed
    t.getStatus("read", 400); t.ingested.length = 0;
    await t.backend.syncAccount(t.account.id);
    expect(await t.cursor()).toEqual(old);
    expect(t.ingested).toEqual([{ id: "arrival", live: false }]);
    const arrival = (await t.backend.store.debug.snapshot()).messages.find((m) => m.providerMsgId === "arrival")!;
    t.getStatus("read", 200); await t.reopen(); t.requests.length = 0;
    await t.backend.syncAccount(t.account.id);
    // the replay finds the arrival held now: its labels are read, it isn't downloaded or inserted again
    expect(t.requests.some((r) => r.pathname === "/messages/arrival" && r.searchParams.get("format") === "raw")).toBe(false);
    expect(t.ingested).toEqual([{ id: "arrival", live: false }]);
    expect((await t.backend.store.debug.snapshot()).messages.find((m) => m.providerMsgId === "arrival")?.id).toBe(arrival.id);
    await t.assertFinal();
  });

  sqlite.each(["references", "bytes", "cycle", "pages", "traversal", "records", "token"] as const)("reconciles bounded history %s from a safe cursor across reopen", async (mode) => {
    const t = await mailbox(kind);
    t.seed();
    await t.backend.syncAccount(t.account.id);
    t.mutate();
    const old = await t.cursor();
    let calls = 0;
    t.historyPayload(() => {
      calls++;
      if (mode === "token") return { historyId: t.terminal, nextPageToken: "x".repeat(4097) };
      if (mode === "records") return { historyId: t.terminal, history: Array.from({ length: 501 }, () => ({})) };
      if (mode === "traversal") return { historyId: t.terminal, nextPageToken: `page${calls}`, history: [{ labelsRemoved: Array.from({ length: 2000 }, () => ({ message: { id: "archive" } })) }] };
      if (mode === "bytes") return { historyId: t.terminal, ignored: "é".repeat(140_000) };
      if (mode === "cycle" || mode === "pages") return { historyId: t.terminal, nextPageToken: mode === "cycle" ? "repeat" : `page${calls}` };
      return { historyId: t.terminal, history: [{ labelsRemoved: Array.from({ length: 2001 }, () => ({ message: { id: "archive" } })) }] };
    });
    t.afterCheckpoint((value) => {
      if (phaseOf(value)?.stage === "enumerate") t.abort.abort(new Error("Pause durable fallback"));
    });
    t.requests.length = 0;
    await t.backend.syncAccount(t.account.id);
    expect(phaseOf(await t.cursor())?.stage).toBe("enumerate");
    expect(await t.cursor()).toMatchObject(old!);
    expect(calls).toBeLessThanOrEqual(mode === "pages" ? 100 : mode === "traversal" ? 6 : 2);
    expect(t.requests.filter((r) => r.pathname.startsWith("/messages/"))).toHaveLength(0);
    t.historyPayload(); t.afterCheckpoint(() => {});
    await t.reopen();
    await t.backend.syncAccount(t.account.id);
    // plan 104: the recovery lists the account's window (all mail took days under the quota and overflowed again)
    expect(t.requests.find((r) => r.pathname === "/messages")?.searchParams.get("q")).toMatch(/^after:\d+$/);
    await t.assertFinal();
    const inserted = [...t.ingested];
    await t.backend.syncAccount(t.account.id);
    expect(t.ingested).toEqual(inserted);
    await t.reopen();
    await t.assertFinal();
  });

  sqlite.each(["initial", "expired"] as const)("catches page-one arrival/archive/delete/read races in the same %s invocation and survives reopen", async (path) => {
    const t = await mailbox(kind);
    if (path === "expired") {
      await t.backend.syncAccount(t.account.id);
      await t.backend.store.accounts.setCursor(t.account.id, { historyId: "1" });
      t.requests.length = 0;
    }
    const arrivals = vi.spyOn(t.backend.store.sync, "arrivals");
    t.seed();
    t.afterIngest(() => {
      expect(t.ingested.map((m) => m.id).sort()).toEqual(["archive", "deleted", "read"]);
      t.mutate();
    });
    await t.backend.syncAccount(t.account.id);
    expect((await t.backend.store.accounts.get(t.account.id))?.syncState.status).toBe("idle");
    await t.assertFinal();
    expect(t.requests.filter((u) => u.pathname === "/history").map((u) => [u.searchParams.get("startHistoryId"), u.searchParams.get("pageToken")])).toEqual([
      ...(path === "expired" ? [["1", null]] : []), [t.baseline, null], [t.baseline, "history/+?=next"],
    ]);
    expect((await t.backend.store.accounts.get(t.account.id))?.syncState.status).toBe("idle");
    await t.assertFinal();
    if (path === "initial") expect(arrivals).not.toHaveBeenCalled();
    else {
      await expect.poll(() => arrivals.mock.calls.length).toBe(1);
      const arrival = (await t.backend.store.providerStore(t.account.id).messageByProviderId("arrival"))!;
      expect(arrivals.mock.calls[0]?.[0]).toEqual([arrival.id]);
    }
    expect(t.ingested.toSorted((a, b) => a.id.localeCompare(b.id))).toEqual([{ id: "archive", live: false }, { id: "arrival", live: true }, { id: "deleted", live: false }, { id: "neighbor", live: false }, { id: "read", live: false }]);
    await t.reopen();
    await t.assertFinal();
    const before = t.ingested.length;
    await t.backend.syncAccount(t.account.id);
    expect(t.ingested).toHaveLength(before);
    await t.assertFinal();
  });
});


describe.each(["SQL", "IndexedDB"] as const)("%s Gmail catch-up failure boundaries", (kind) => {
  const sqlite = onSqlite(kind);
  it.each(["baseline", "terminal"] as const)("replays after a failed %s cursor write without duplicate ingestion", async (checkpoint) => {
    const t = await mailbox(kind);
    t.seed(); t.afterIngest(t.mutate);
    const setCursor = t.backend.store.accounts.setCursor.bind(t.backend.store.accounts);
    let refused = false;
    const write = vi.spyOn(t.backend.store.accounts, "setCursor").mockImplementation(async (id, value) => {
      if (!refused && (checkpoint === "baseline" ? phaseOf(value)?.stage === "catchup" : (value as { historyId: string }).historyId === t.terminal)) { refused = true; throw new Error("Synthetic checkpoint failure"); }
      return setCursor(id, value);
    });
    await t.backend.syncAccount(t.account.id);
    expect(refused).toBe(true);
    expect(await t.cursor()).toMatchObject({ reconciliation: { stage: checkpoint === "baseline" ? "refresh" : "catchup", baseline: t.baseline } });
    expect(await t.cursor()).not.toHaveProperty("historyId");
    expect((await t.backend.store.accounts.get(t.account.id))?.syncState.status).not.toBe("idle");
    expect(t.requests.filter((u) => u.pathname === "/history")).toHaveLength(checkpoint === "baseline" ? 0 : 2);
    write.mockRestore();
    await t.reopen();
    await t.backend.syncAccount(t.account.id);
    await t.assertFinal();
    expect(t.ingested.filter((m) => m.id === "arrival")).toHaveLength(1);
    expect(t.ingested.filter((m) => m.id === "archive")).toHaveLength(1);
  });

  it.each(["updateFlags", "remove"] as const)("replays a failed catch-up %s effect from the original baseline", async (effect) => {
    const t = await mailbox(kind); t.seed();
    t.afterCheckpoint((value) => { if (phaseOf(value)?.stage === "catchup") { t.afterCheckpoint(() => {}); t.mutate(); } });
    const update = t.backend.store.sync.updateFlags.bind(t.backend.store.sync);
    const remove = t.backend.store.sync.remove.bind(t.backend.store.sync);
    const write = effect === "updateFlags"
      ? vi.spyOn(t.backend.store.sync, "updateFlags").mockImplementation(async (...args) => {
        if (t.requests.some((u) => u.pathname === "/history")) throw new Error("Synthetic effect failure");
        return update(...args);
      })
      : vi.spyOn(t.backend.store.sync, "remove").mockImplementation(async (...args) => {
        if (t.requests.some((u) => u.pathname === "/history")) throw new Error("Synthetic effect failure");
        return remove(...args);
      });
    await t.backend.syncAccount(t.account.id);
    expect(write).toHaveBeenCalled();
    expect(await t.cursor()).toMatchObject({ reconciliation: { stage: "catchup", baseline: t.baseline } });
    expect(await t.cursor()).not.toHaveProperty("historyId");
    expect((await t.backend.store.accounts.get(t.account.id))?.syncState.status).not.toBe("idle");
    const before = (await t.backend.store.debug.snapshot()).messages;
    const arrival = before.find((m) => m.providerMsgId === "arrival")!;
    const assets = await t.backend.store.attachments.current(t.account.id, { id: arrival.id });
    expect(before.some((m) => m.providerMsgId === "deleted")).toBe(true);
    write.mockRestore(); await t.reopen();
    await t.backend.syncAccount(t.account.id); await t.assertFinal();
    expect((await t.backend.store.debug.snapshot()).messages.find((m) => m.providerMsgId === "arrival")?.id).toBe(arrival.id);
    expect(await t.backend.store.attachments.current(t.account.id, { id: arrival.id })).toEqual(assets);
    expect(t.ingested.filter((m) => m.id === "arrival")).toHaveLength(1);
  });

  sqlite("accepts empty catch-up with a valid terminal ID in the same initial invocation", async () => {
    const t = await mailbox(kind);
    await t.backend.syncAccount(t.account.id);
    expect(t.requests.filter((u) => u.pathname === "/history").map((u) => u.searchParams.get("startHistoryId"))).toEqual([t.baseline]);
    expect(await t.cursor()).toEqual({ historyId: t.baseline });
    expect((await t.backend.store.accounts.get(t.account.id))?.syncState.status).toBe("idle");
    await t.reopen(); expect(await t.cursor()).toEqual({ historyId: t.baseline });
  });

  sqlite("leaves an expired catch-up baseline for a later invocation, with no same-call reset loop or success", async () => {
    const t = await mailbox(kind);
    t.seed(); t.afterIngest(t.mutate); t.historyStatus(404);
    await t.backend.store.accounts.setCursor(t.account.id, { historyId: "1" });
    await t.backend.syncAccount(t.account.id);
    expect(t.requests.filter((u) => u.pathname === "/history").map((u) => u.searchParams.get("startHistoryId"))).toEqual(["1", t.baseline]);
    expect(t.requests.filter((u) => u.pathname === "/profile")).toHaveLength(1);
    expect(await t.cursor()).toEqual({ historyId: "1", reconciliation: { version: 1, stage: "restart" } });
    expect((await t.backend.store.accounts.get(t.account.id))?.syncState.status).not.toBe("idle");
    expect(t.backend.connectivity.failures(t.account.id)).toBe(1);
    t.historyStatus(200); await t.reopen();
    await t.backend.syncAccount(t.account.id); await t.assertFinal();
  });

  sqlite.each([404, 503])("scopes catch-up raw-message %s to that resource without another full reconciliation", async (status) => {
    const t = await mailbox(kind);
    t.seed(); t.afterIngest(t.mutate); t.rawStatus(status);
    await t.backend.syncAccount(t.account.id);
    expect(t.requests.filter((u) => u.pathname === "/history")).toHaveLength(2);
    expect(t.requests.filter((u) => u.pathname === "/profile")).toHaveLength(1);
    expect(t.requests.some((u) => u.pathname === "/messages/arrival")).toBe(true);
    if (status === 404) expect(await t.cursor()).toEqual({ historyId: t.terminal });
    else expect(await t.cursor()).toMatchObject({ reconciliation: { stage: "catchup", baseline: t.baseline } });
    if (status === 503) {
      t.rawStatus(200); await t.reopen();
      await t.backend.syncAccount(t.account.id); await t.assertFinal();
    } else {
      expect((await t.backend.store.debug.snapshot()).messages.map((m) => m.providerMsgId).sort()).toEqual(["archive", "neighbor", "read"]);
      expect((await t.backend.store.accounts.get(t.account.id))?.syncState.status).toBe("idle");
    }
  });

  sqlite("does not remove messages, checkpoint, or dispatch after cancellation following a flag write", async () => {
    const t = await mailbox(kind); t.seed();
    t.afterCheckpoint((value) => { if (phaseOf(value)?.stage === "catchup") { t.afterCheckpoint(() => {}); t.mutate(); } });
    const update = t.backend.store.sync.updateFlags.bind(t.backend.store.sync);
    let at = -1;
    vi.spyOn(t.backend.store.sync, "updateFlags").mockImplementation(async (...args) => {
      const result = await update(...args);
      if (t.requests.some((u) => u.pathname === "/history")) {
        at = t.requests.length;
        t.abort.abort(new Error("Synthetic cancellation after flag write"));
      }
      return result;
    });
    await t.backend.syncAccount(t.account.id);
    expect(t.abort.signal.aborted).toBe(true);
    expect(t.requests).toHaveLength(at);
    expect(await t.cursor()).toMatchObject({ reconciliation: { stage: "catchup", baseline: t.baseline } });
    expect((await t.backend.store.debug.snapshot()).messages.some((m) => m.providerMsgId === "deleted")).toBe(true);
    expect((await t.backend.store.accounts.get(t.account.id))?.syncState.status).not.toBe("idle");
  });

  sqlite.each(["page", "baseline"] as const)("issues no later HTTP or checkpoint after cancellation at %s", async (boundary) => {
    const t = await mailbox(kind); t.seed();
    if (boundary === "page") t.afterIngest(() => t.abort.abort(new Error("Synthetic cancellation")));
    else t.afterCheckpoint((value) => { if (phaseOf(value)?.stage === "catchup") t.abort.abort(new Error("Synthetic cancellation")); });
    await t.backend.syncAccount(t.account.id);
    expect(t.abort.signal.aborted).toBe(true);
    expect(t.requests.filter((u) => u.pathname === "/history")).toEqual([]);
    expect(t.requests.filter((u) => u.pathname === "/messages")).toHaveLength(boundary === "page" ? 1 : 2);
    expect(await t.cursor()).toMatchObject({ reconciliation: { stage: boundary === "page" ? "enumerate" : "catchup", baseline: t.baseline } });
    expect(await t.cursor()).not.toHaveProperty("historyId");
    expect((await t.backend.store.accounts.get(t.account.id))?.syncState.status).not.toBe("idle");
  });
});


describe.each(["SQL", "IndexedDB"] as const)("%s actions taken while a new label is being created (plan 229)", (kind) => {
  it("read and archive taken while Gmail creates a label stay done when it's created, and reach Gmail", async () => {
    const t = await mailbox(kind, true);
    t.seed();
    await t.backend.syncAccount(t.account.id);
    expect(await t.cursor()).toEqual({ historyId: t.terminal });
    const [remote, local] = createMemoryTransportPair();
    t.backend.connect(remote, { clientId: "synthetic", origin: "renderer" });
    const rpc = new RpcClient(local);
    const row = async () => (await t.backend.store.debug.snapshot()).messages.find((m) => m.providerMsgId === "neighbor")!;
    const threadId = (await row()).threadId;
    expect(await row()).toMatchObject({ inInbox: true, isRead: false });
    // New label: Gmail takes its time
    let release!: () => void;
    const reached = new Promise<void>((resolve) => t.holdLabel((send) => { release = send; resolve(); }));
    const creating = rpc.call("folders.create", { accountId: t.account.id, parent: null, name: "Terno review" });
    await reached;
    // meanwhile: unread, read, archive
    for (const action of ["markUnread", "markRead", "archive"] as const) await rpc.call("threads.act", { threadIds: [threadId], action });
    expect(await row()).toMatchObject({ inInbox: false, isRead: true });
    release();
    const label = await creating;
    // whatever runs now (the pass the change asks for, the ops it held back): nothing the person did is undone
    const states: unknown[] = [];
    for (let i = 0; i < 200; i++) {
      const r = await row();
      states.push({ inInbox: r.inInbox, isRead: r.isRead });
      if ((await t.backend.store.debug.snapshot()).ops.every((o) => o.state === "succeeded") && !(t.backend as unknown as { syncing: Map<number, unknown> }).syncing.has(t.account.id)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(states.filter((s) => JSON.stringify(s) !== JSON.stringify({ inInbox: false, isRead: true }))).toEqual([]);
    expect(t.messages.get("neighbor")!.labelIds).toEqual([]);
    // and the move to the new label
    await rpc.call("folders.moveThreads", { accountId: t.account.id, folder: label.key, from: null, threadIds: [threadId] });
    expect(await row()).toMatchObject({ inInbox: false, isRead: true });
  });
});

describe.each(["SQL", "IndexedDB"] as const)("%s actions on a conversation Gmail changed before Terno read it back (plan 229)", (kind) => {
  it("unread, read and archive while a label is created: Gmail's newer Inbox and unread don't come back", async () => {
    const t = await mailbox(kind, true);
    t.seed();
    // a conversation of two: the first in the Inbox, read; the reply read and archived when Terno synced (your own
    // reply, as Terno stored it when it sent it)
    t.messages.get("neighbor")!.labelIds = ["INBOX"];
    t.reply("neighbor-re", "neighbor");
    t.messages.get("neighbor-re")!.labelIds = [];
    await t.backend.syncAccount(t.account.id);
    const rows = async () => (await t.backend.store.debug.snapshot()).messages.filter((m) => m.providerMsgId?.startsWith("neighbor"));
    const row = async () => (await rows()).find((m) => m.providerMsgId === "neighbor-re")!;
    expect((await rows()).map((m) => m.threadId)).toEqual([(await row()).threadId, (await row()).threadId]);
    expect(await row()).toMatchObject({ inInbox: false, isRead: true });
    // Gmail puts the reply in the Inbox, unread (your own mail delivered to you): not read back yet
    t.label("neighbor-re", ["INBOX", "UNREAD"]);
    const [remote, local] = createMemoryTransportPair();
    t.backend.connect(remote, { clientId: "synthetic", origin: "renderer" });
    const rpc = new RpcClient(local);
    const threadId = (await row()).threadId;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => t.holdLabel((send) => { release = send; resolve(); }));
    const creating = rpc.call("folders.create", { accountId: t.account.id, parent: null, name: "Terno review" });
    await reached;
    for (const action of ["markUnread", "markRead", "archive"] as const) await rpc.call("threads.act", { threadIds: [threadId], action });
    release();
    await creating;
    // the pass the change asks for and the ops it held back run now: never a moment back in the Inbox or unread
    const seen = new Set<string>();
    for (let i = 0; i < 300; i++) {
      for (const m of await rows()) seen.add(JSON.stringify({ inInbox: m.inInbox, isRead: m.isRead }));
      const ops = (await t.backend.store.debug.snapshot()).ops;
      if (ops.every((o) => o.state === "succeeded") && !(t.backend as unknown as { syncing: Map<number, unknown> }).syncing.has(t.account.id)) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await t.backend.syncAccount(t.account.id);
    for (const m of await rows()) seen.add(JSON.stringify({ inInbox: m.inInbox, isRead: m.isRead }));
    expect([...seen]).toEqual([JSON.stringify({ inInbox: false, isRead: true })]);
    // Gmail heard read and archive for the whole conversation (the unread before it was superseded, never sent)
    expect(t.modified.map((m) => ({ ...m, ids: [...m.ids].sort() }))).toEqual([{ ids: ["neighbor", "neighbor-re"], add: [], remove: ["UNREAD"] }, { ids: ["neighbor", "neighbor-re"], add: [], remove: ["INBOX"] }]);
    // what the person did is what Terno shows, and what Gmail holds
    for (const m of await rows()) expect(m).toMatchObject({ inInbox: false, isRead: true });
    expect(t.messages.get("neighbor")!.labelIds).toEqual([]);
    expect(t.messages.get("neighbor-re")!.labelIds).toEqual([]);
  });
});

describe.each(["SQL", "IndexedDB"] as const)("%s Gmail changes during a first sync (plan 227)", (kind) => {
  it("a message you send to yourself while the first sync lists is in the Inbox at the next look, and an archive here holds", async () => {
    const t = await mailbox(kind); t.seed(); t.listStatus(503);
    // the first page is in, the next one refused: the first sync is still listing
    await t.backend.syncAccount(t.account.id);
    expect(phaseOf(await t.cursor())).toMatchObject({ stage: "enumerate", pages: 1 });
    await t.backend.store.compose.queueSend({ accountId: t.account.id, to: [{ name: "", email: "me@example.test" }], cc: [], bcc: [], subject: "To myself", bodyText: "Note", recordReply: false, now: Date.now() });
    expect(await t.backend.runWorker()).toBe(1);
    const self = async () => (await t.backend.store.debug.snapshot()).messages.find((m) => m.providerMsgId === "self")!;
    expect(await self()).toMatchObject({ inInbox: false });
    // Gmail delivers it to you too
    t.label("self", ["SENT", "INBOX", "UNREAD"]);
    await t.backend.syncAccount(t.account.id);
    expect(await self()).toMatchObject({ inInbox: true, gmailLabels: JSON.stringify(["SENT", "INBOX", "UNREAD"]) });
    expect(phaseOf(await t.cursor())).toMatchObject({ stage: "enumerate", pages: 1 });
    // archived here, not yet at Gmail: a later look that reads INBOX doesn't bring it back (a star from elsewhere does land)
    await t.backend.store.threads.act({ threadIds: [(await self()).threadId], action: "archive", signal: null, now: Date.now() });
    t.label("self", ["SENT", "INBOX", "UNREAD", "STARRED"]);
    await t.backend.syncAccount(t.account.id);
    expect(await self()).toMatchObject({ inInbox: false, isStarred: true });
  });
});

describe.each(["SQL", "IndexedDB"] as const)("%s Gmail durable enumeration", (kind) => {
  const sqlite = onSqlite(kind);
  it.each(["initial", "expired"] as const)("resumes a committed %s list page after real close/reopen, then catches up from the original baseline", async (path) => {
    const t = await mailbox(kind);
    if (path === "expired") await t.backend.store.accounts.setCursor(t.account.id, { historyId: "1" });
    t.seed(); t.afterIngest(t.mutate);
    t.afterCheckpoint((value) => { if (phaseOf(value)?.pages === 1) t.abort.abort(new Error("Synthetic crash after page checkpoint")); });
    const lastSyncAt = (await t.backend.store.accounts.get(t.account.id))?.syncState.lastSyncAt;
    await t.backend.syncAccount(t.account.id);
    t.afterCheckpoint(() => {});
    expect(t.requests.filter((u) => u.pathname === "/messages")).toHaveLength(1);
    expect((await t.backend.store.accounts.get(t.account.id))?.syncState.lastSyncAt).toBe(lastSyncAt);
    const saved = await t.cursor();
    expect(saved).toMatchObject({ ...(path === "expired" && { historyId: "1" }), reconciliation: { stage: "enumerate", baseline: t.baseline, next: "list/+?=next", pages: 1 } });
    if (path === "initial") expect(saved).not.toHaveProperty("historyId");
    expect((await t.backend.store.accounts.get(t.account.id))?.syncState.status).not.toBe("idle");
    const query = t.requests.find((u) => u.pathname === "/messages")!.searchParams.get("q");
    await t.reopen(); expect(await t.cursor()).toEqual(saved);
    t.advanceTime(); t.requests.length = 0; t.listStatus(200);
    await t.backend.syncAccount(t.account.id); await t.assertFinal();
    expect(t.requests.filter((u) => u.pathname === "/profile")).toHaveLength(0);
    expect(t.requests.filter((u) => u.pathname === "/messages").map((u) => [u.searchParams.get("pageToken"), u.searchParams.get("q")])).toEqual([["list/+?=next", query]]);
    expect(t.requests.filter((u) => u.pathname === "/history").every((u) => u.searchParams.get("startHistoryId") === t.baseline)).toBe(true);
    expect(t.ingested.filter((m) => m.id === "archive")).toHaveLength(1);
    expect((await t.backend.store.accounts.get(t.account.id))?.syncState.status).toBe("idle");
  });

  it.each(["before", "after"] as const)("replays safely after a page checkpoint rejects %s its durable commit", async (boundary) => {
    const t = await mailbox(kind); t.seed();
    const set = t.backend.store.accounts.setCursor.bind(t.backend.store.accounts);
    const write = vi.spyOn(t.backend.store.accounts, "setCursor").mockImplementation(async (id, value) => {
      if ((value as { reconciliation?: { pages: number } }).reconciliation?.pages === 1) {
        if (boundary === "after") await set(id, value);
        throw new Error("Synthetic page checkpoint rejection");
      }
      await set(id, value);
    });
    await t.backend.syncAccount(t.account.id);
    expect(t.requests.filter((u) => u.pathname === "/messages")).toHaveLength(1);
    expect((await t.backend.store.accounts.get(t.account.id))?.syncState.status).not.toBe("idle");
    expect((await t.backend.store.debug.snapshot()).messages).toHaveLength(3);
    write.mockRestore(); await t.reopen(); t.requests.length = 0;
    await t.backend.syncAccount(t.account.id);
    expect(t.requests.find((u) => u.pathname === "/messages")?.searchParams.get("pageToken")).toBe(boundary === "after" ? "list/+?=next" : null);
    expect(t.ingested.map((m) => m.id).sort()).toEqual(["archive", "deleted", "neighbor", "read"]);
    expect(await t.cursor()).toEqual({ historyId: t.baseline });
  });

  sqlite("retains catch-up phase and the last completed history through a catch-up failure and reopen", async () => {
    const t = await mailbox(kind); t.seed(); t.afterIngest(t.mutate); t.historyStatus(503);
    await t.backend.store.accounts.setCursor(t.account.id, { historyId: "1" });
    await t.backend.syncAccount(t.account.id);
    const saved = await t.cursor();
    expect(saved).toMatchObject({ historyId: "1", reconciliation: { stage: "catchup", baseline: t.baseline } });
    await t.reopen(); expect(await t.cursor()).toEqual(saved); t.historyStatus(200); t.requests.length = 0;
    await t.backend.syncAccount(t.account.id); await t.assertFinal();
    expect(t.requests.filter((u) => u.pathname === "/messages" || u.pathname === "/profile")).toHaveLength(0);
  });

  sqlite("never advances the page after a failed raw GET, and replays without duplicate ingestion", async () => {
    const t = await mailbox(kind); t.seed(); t.getStatus("read", 503);
    await t.backend.syncAccount(t.account.id);
    expect(await t.cursor()).toMatchObject({ reconciliation: { stage: "enumerate", pages: 0 } });
    expect(t.requests.filter((u) => u.pathname === "/messages")).toHaveLength(1);
    await t.reopen(); t.getStatus("read", 200); t.requests.length = 0;
    await t.backend.syncAccount(t.account.id);
    expect(t.requests.find((u) => u.pathname === "/messages")?.searchParams.has("pageToken")).toBe(false);
    expect(t.ingested.map((m) => m.id).sort()).toEqual(["archive", "deleted", "neighbor", "read"]);
    expect(await t.cursor()).toEqual({ historyId: t.baseline });
  });

  sqlite("does not infer deletion from an empty list page", async () => {
    const t = await mailbox(kind); t.seed(); t.emptyFirst(); t.listStatus(503);
    await t.backend.syncAccount(t.account.id);
    expect(await t.cursor()).toMatchObject({ reconciliation: { next: "list/+?=next", pages: 1 } });
    await t.reopen(); t.listStatus(200);
    await t.backend.syncAccount(t.account.id);
    expect((await t.backend.store.debug.snapshot()).messages).toHaveLength(4);
    expect(await t.cursor()).toEqual({ historyId: t.baseline });
  });

  sqlite.each([400, 404])("forgets an expired enumeration token (%s) and fails retryably without looping", async (status) => {
    const t = await mailbox(kind); t.seed(); t.listStatus(503);
    await t.backend.syncAccount(t.account.id); await t.reopen(); t.requests.length = 0; t.listStatus(status);
    await t.backend.syncAccount(t.account.id);
    expect(t.requests.filter((u) => u.pathname === "/messages")).toHaveLength(1);
    expect(t.requests.filter((u) => u.pathname === "/profile")).toHaveLength(0);
    expect(await t.cursor()).toEqual({ reconciliation: { version: 1, stage: "restart" } });
    expect((await t.backend.store.accounts.get(t.account.id))?.syncState.status).not.toBe("idle");
    expect(t.backend.connectivity.failures(t.account.id)).toBe(1);
    await t.reopen(); t.listStatus(200);
    await t.backend.syncAccount(t.account.id);
    expect(await t.cursor()).toEqual({ historyId: t.baseline });
  });

  sqlite("refuses an oversized opaque token without saving or consuming it", async () => {
    const t = await mailbox(kind); t.seed(); t.nextToken("x".repeat(4097));
    await t.backend.syncAccount(t.account.id);
    expect(t.requests.filter((u) => u.pathname === "/messages")).toHaveLength(1);
    expect(JSON.stringify(await t.cursor()).length).toBeLessThan(1024);
    expect((await t.backend.store.accounts.get(t.account.id))?.syncState.status).not.toBe("idle");
  });

  it.each(["before", "after"] as const)("replays an ingest rejection %s commit from the same durable page", async (boundary) => {
    const t = await mailbox(kind); t.seed();
    const ingest = t.backend.store.sync.ingest.bind(t.backend.store.sync);
    const failure = vi.spyOn(t.backend.store.sync, "ingest").mockImplementationOnce(async (...args) => {
      if (boundary === "after") await ingest(...args);
      throw new Error("Synthetic ingest failure");
    });
    await t.backend.syncAccount(t.account.id);
    expect(await t.cursor()).toMatchObject({ reconciliation: { stage: "enumerate", pages: 0 } });
    expect(t.requests.filter((u) => u.pathname === "/messages")).toHaveLength(1);
    failure.mockRestore(); await t.reopen(); t.requests.length = 0;
    await t.backend.syncAccount(t.account.id);
    expect(t.requests.find((u) => u.pathname === "/messages")?.searchParams.has("pageToken")).toBe(false);
    expect((await t.backend.store.debug.snapshot()).messages.map((m) => m.providerMsgId).sort()).toEqual(["archive", "deleted", "neighbor", "read"]);
    expect(await t.cursor()).toEqual({ historyId: t.baseline });
    expect((await t.backend.store.debug.snapshot()).ops).toHaveLength(0);
  });

  sqlite("cancellation after page effects does not advance the token and can resume on reopen", async () => {
    const t = await mailbox(kind); t.seed(); t.afterIngest(() => t.abort.abort(new Error("Synthetic cancellation")));
    await t.backend.syncAccount(t.account.id);
    expect(await t.cursor()).toMatchObject({ reconciliation: { stage: "enumerate", pages: 0 } });
    expect(t.requests.filter((u) => u.pathname === "/messages")).toHaveLength(1);
    await t.reopen(); t.requests.length = 0;
    await t.backend.syncAccount(t.account.id);
    expect(t.requests.find((u) => u.pathname === "/messages")?.searchParams.has("pageToken")).toBe(false);
    expect(t.ingested.map((m) => m.id).sort()).toEqual(["archive", "deleted", "neighbor", "read"]);
    expect(await t.cursor()).toEqual({ historyId: t.baseline });
  });

  it("fences the old credential generation before its page checkpoint", async () => {
    const t = await mailbox(kind); t.seed();
    t.afterIngest(() => t.backend.signedIn(t.account.id));
    await t.backend.syncAccount(t.account.id);
    expect(t.backend.credentialsOf(t.account.id)).toBe(1);
    expect(await t.cursor()).toMatchObject({ reconciliation: { stage: "enumerate", pages: 0 } });
    expect(t.requests.filter((u) => u.pathname === "/messages")).toHaveLength(1);
    expect(t.requests.filter((u) => u.pathname === "/history")).toHaveLength(0);
    await t.reopen(); await t.backend.syncAccount(t.account.id);
    expect(await t.cursor()).toEqual({ historyId: t.baseline });
  });

  it("removal after page effects leaves neither a cursor nor later requests", async () => {
    const t = await mailbox(kind); t.seed();
    t.afterIngest(async () => {
      await t.backend.dropAccount(t.account.id, { remove: true });
      await t.backend.store.accounts.remove(t.account.id); t.backend.accountRemoved(t.account.id);
    });
    await t.backend.syncAccount(t.account.id);
    expect(await t.backend.store.accounts.get(t.account.id)).toBeNull();
    expect(await t.cursor()).toBeUndefined();
    expect(t.requests.filter((u) => u.pathname === "/messages")).toHaveLength(1);
    await t.reopen(); expect(await t.cursor()).toBeUndefined();
  });

  sqlite.each(["window", "identity", "version"] as const)("restarts a persisted phase with changed %s rather than consuming its token", async (change) => {
    const t = await mailbox(kind); t.seed(); t.listStatus(503);
    await t.backend.syncAccount(t.account.id);
    expect(await t.cursor()).toHaveProperty("reconciliation");
    if (change === "window") await t.backend.store.accounts.update(t.account.id, { syncWindowDays: 60 });
    else {
      const saved = await t.cursor() as { reconciliation: Record<string, unknown> };
      await t.backend.store.accounts.setCursor(t.account.id, { ...saved, reconciliation: { ...saved.reconciliation, ...(change === "identity" ? { email: "other@example.test" } : { version: 999 }) } });
    }
    await t.reopen(); t.listStatus(200); t.requests.length = 0;
    await t.backend.syncAccount(t.account.id);
    expect(t.requests.filter((u) => u.pathname === "/profile")).toHaveLength(1);
    expect(t.requests.find((u) => u.pathname === "/messages")?.searchParams.has("pageToken")).toBe(false);
    expect(await t.cursor()).toEqual({ historyId: t.baseline });
  });


  it.each(["refresh", "catchup"] as const)("resolves a rejected %s transition from the actual durable row", async (stage) => {
    const t = await mailbox(kind); t.seed();
    const set = t.backend.store.accounts.setCursor.bind(t.backend.store.accounts);
    const write = vi.spyOn(t.backend.store.accounts, "setCursor").mockImplementation(async (id, value) => {
      await set(id, value);
      if (phaseOf(value)?.stage === stage) throw new Error("Synthetic transition rejection after commit");
    });
    await t.backend.syncAccount(t.account.id);
    expect(await t.cursor()).toMatchObject({ reconciliation: { stage, baseline: t.baseline } });
    write.mockRestore(); await t.reopen(); t.requests.length = 0;
    await t.backend.syncAccount(t.account.id);
    expect(t.requests.filter((u) => u.pathname === "/messages" || u.pathname === "/profile")).toHaveLength(0);
    expect(await t.cursor()).toEqual({ historyId: t.baseline });
    expect(t.ingested.map((m) => m.id).sort()).toEqual(["archive", "deleted", "neighbor", "read"]);
  });

  it.each(["updateFlags", "remove"] as const)("replays a refresh %s that committed before rejecting", async (effect) => {
    const t = await mailbox(kind); t.seed(); t.afterIngest(t.mutate);
    const update = t.backend.store.sync.updateFlags.bind(t.backend.store.sync);
    const remove = t.backend.store.sync.remove.bind(t.backend.store.sync);
    const write = effect === "updateFlags"
      ? vi.spyOn(t.backend.store.sync, "updateFlags").mockImplementation(async (...args) => { await update(...args); throw new Error("Synthetic refresh post-commit failure"); })
      : vi.spyOn(t.backend.store.sync, "remove").mockImplementation(async (...args) => { await remove(...args); throw new Error("Synthetic refresh post-commit failure"); });
    await t.backend.syncAccount(t.account.id);
    expect(write).toHaveBeenCalled();
    expect(await t.cursor()).toMatchObject({ reconciliation: { stage: "refresh", baseline: t.baseline } });
    expect(t.requests.filter((u) => u.pathname === "/history")).toHaveLength(0);
    write.mockRestore(); await t.reopen(); t.requests.length = 0;
    await t.backend.syncAccount(t.account.id); await t.assertFinal();
    expect(t.requests.filter((u) => u.pathname === "/messages" || u.pathname === "/profile")).toHaveLength(0);
  });

  sqlite("retains known messages until enumeration has completed and explicit refresh coverage validates deletion", async () => {
    const t = await mailbox(kind); t.seed();
    await t.backend.syncAccount(t.account.id);
    t.messages.delete("archive"); t.add("extra");
    await t.backend.store.accounts.setCursor(t.account.id, { historyId: "1" });
    t.listStatus(503); t.requests.length = 0;
    await t.backend.syncAccount(t.account.id);
    expect(await t.backend.store.providerStore(t.account.id).messageByProviderId("archive")).not.toBeNull();
    expect(t.requests.some((u) => u.pathname === "/messages/archive")).toBe(false);
    await t.reopen(); t.listStatus(200); t.requests.length = 0;
    await t.backend.syncAccount(t.account.id);
    expect(t.requests.some((u) => u.pathname === "/messages/archive")).toBe(true);
    expect(await t.backend.store.providerStore(t.account.id).messageByProviderId("archive")).toBeNull();
    expect(await t.cursor()).toEqual({ historyId: t.baseline });
  });

  sqlite.each(["cycle", "limit"] as const)("bounds a persisted token %s across reopen without false completion", async (boundary) => {
    const t = await mailbox(kind); t.seed(); t.listStatus(503);
    await t.backend.syncAccount(t.account.id);
    const saved = await t.cursor() as { reconciliation: Record<string, unknown> };
    if (boundary === "limit") await t.backend.store.accounts.setCursor(t.account.id, { ...saved, reconciliation: { ...saved.reconciliation, pages: 10_000 } });
    else t.nextToken("list/+?=next");
    await t.reopen(); t.listStatus(200); t.requests.length = 0;
    if (boundary === "cycle") t.repeatToken();
    await t.backend.syncAccount(t.account.id);
    // no catch-up: the one history read is the look at new mail that comes first (plan 102; it reads label changes
    // too since plan 227, the same types as a catch-up)
    expect(t.requests.filter((u) => u.pathname === "/history")).toHaveLength(1);
    expect(await t.cursor()).toEqual({ reconciliation: { version: 1, stage: "restart" } });
    expect((await t.backend.store.accounts.get(t.account.id))?.syncState.status).not.toBe("idle");
  });


  sqlite("refuses later refresh chunks after credentials change following the first committed chunk", async () => {
    const t = await mailbox(kind);
    for (let i = 0; i < 120; i++) t.add(`chunk-${i}`);
    const update = t.backend.store.sync.updateFlags.bind(t.backend.store.sync);
    const writes = vi.spyOn(t.backend.store.sync, "updateFlags").mockImplementation(async (...args) => {
      const result = await update(...args);
      if (t.backend.credentialsOf(t.account.id) === 0) await t.backend.signedIn(t.account.id);
      return result;
    });
    await t.backend.syncAccount(t.account.id);
    expect(writes).toHaveBeenCalledTimes(1);
    expect(writes.mock.calls[0]![1]).toHaveLength(50);
    expect(await t.cursor()).toMatchObject({ reconciliation: { stage: "refresh", baseline: t.baseline } });
    expect(t.requests.filter((u) => u.pathname === "/history")).toHaveLength(0);
    expect((await t.backend.store.accounts.get(t.account.id))?.syncState.lastSyncAt).toBeNull();
    writes.mockRestore(); await t.reopen(); t.requests.length = 0;
    await t.backend.syncAccount(t.account.id);
    expect(await t.cursor()).toEqual({ historyId: t.baseline });
    expect(t.requests.filter((u) => u.pathname === "/messages" || u.pathname === "/profile")).toHaveLength(0);
    expect((await t.backend.store.debug.snapshot()).messages).toHaveLength(120);
  });

  sqlite("rechecks credentials after classifier preparation before admitting ingestion", async () => {
    const t = await mailbox(kind); t.seed();
    const writes = vi.spyOn(t.backend.store.sync, "ingest");
    vi.spyOn(t.backend, "classifier").mockImplementationOnce(async () => { await t.backend.signedIn(t.account.id); return null; });
    await t.backend.syncAccount(t.account.id);
    expect(writes).not.toHaveBeenCalled();
    expect(await t.cursor()).toMatchObject({ reconciliation: { stage: "enumerate", pages: 0 } });
    expect((await t.backend.store.debug.snapshot()).messages).toHaveLength(0);
    await t.reopen(); await t.backend.syncAccount(t.account.id);
    expect(await t.cursor()).toEqual({ historyId: t.baseline });
    expect((await t.backend.store.debug.snapshot()).messages).toHaveLength(4);
  });


  sqlite("does not publish a stale syncing state when credentials change during window preparation", async () => {
    const t = await mailbox(kind); t.seed();
    const read = t.backend.store.settings.get.bind(t.backend.store.settings);
    let replace = true;
    vi.spyOn(t.backend.store.settings, "get").mockImplementation(async <T,>(key: string, fallback: T): Promise<T> => {
      const result = await read(key, fallback);
      if (key === "app" && replace) { replace = false; await t.backend.signedIn(t.account.id); }
      return result;
    });
    await t.backend.syncAccount(t.account.id);
    expect(replace).toBe(false);
    expect((await t.backend.store.accounts.get(t.account.id))?.syncState).toMatchObject({ status: "idle", lastSyncAt: null });
    expect(await t.cursor()).toBeUndefined();
    expect(t.requests).toHaveLength(0);
    await t.reopen(); await t.backend.syncAccount(t.account.id);
    expect(await t.cursor()).toEqual({ historyId: t.baseline });
  });

});


// who runs when is the backend's, over any store's answers
describe.each(["SQL"] as const)("%s managed Gmail concurrent public sync requests", (kind) => {
  it("does not spin after a failed trailing pass and a later request recovers", async () => {
    const t = await mailbox(kind); t.seed(); await t.backend.syncAccount(t.account.id); t.requests.length = 0;
    const [local, remote] = createMemoryTransportPair();
    t.backend.connect(remote, { clientId: "synthetic", origin: "renderer" });
    const rpc = new RpcClient(local); let release = () => {}, entered!: () => void;
    const held = new Promise<void>((resolve) => { entered = resolve; });
    cleanup.push(async () => { release(); rpc.close(); });
    t.holdHistory((send) => { release = send; entered(); });
    const sync = vi.spyOn(t.backend, "syncAccount");
    const first = t.backend.syncAccount(t.account.id); await held;
    t.mutate(); await rpc.call("sync.now", { accountId: t.account.id });
    t.historyStatus(503); release(); release = () => {}; await first;
    await Promise.all(sync.mock.results.map((result) => result.value));
    expect(sync).toHaveBeenCalledTimes(3);
    expect((await t.backend.store.accounts.get(t.account.id))?.syncState.lastError).toBeTruthy();
    expect(t.requests.filter((u) => u.pathname === "/history")).toHaveLength(2);
    expect(await t.cursor()).toEqual({ historyId: t.baseline });
    t.historyStatus(200);
    await rpc.call("sync.now", { accountId: t.account.id });
    expect(sync).toHaveBeenCalledTimes(4);
    await sync.mock.results[3]!.value;
    expect((await t.backend.store.accounts.get(t.account.id))?.syncState).toMatchObject({ status: "idle", lastError: null });
    await t.assertFinal();
    await t.reopen(); await t.assertFinal();
  });
  it("runs a third pass for a new public request during the trailing pass", async () => {
    const t = await mailbox(kind); t.seed(); await t.backend.syncAccount(t.account.id); t.requests.length = 0;
    const [local, remote] = createMemoryTransportPair();
    t.backend.connect(remote, { clientId: "synthetic", origin: "renderer" });
    const rpc = new RpcClient(local);
    let releaseFirst = () => {}, releaseSecond = () => {}, enterFirst!: () => void, enterSecond!: () => void;
    const firstEntered = new Promise<void>((resolve) => { enterFirst = resolve; });
    const secondEntered = new Promise<void>((resolve) => { enterSecond = resolve; });
    cleanup.push(async () => { releaseFirst(); releaseSecond(); rpc.close(); });
    t.holdHistory((send) => { releaseFirst = send; enterFirst(); });
    const sync = vi.spyOn(t.backend, "syncAccount");
    const first = t.backend.syncAccount(t.account.id); await firstEntered;
    t.add("middle", true);
    await rpc.call("sync.now", { accountId: t.account.id });
    t.holdHistory((send) => { releaseSecond = send; enterSecond(); });
    releaseFirst(); releaseFirst = () => {}; await first; await secondEntered;
    t.add("last", true);
    await rpc.call("sync.now", { accountId: t.account.id });
    expect(t.requests.filter((u) => u.pathname === "/history")).toHaveLength(2);
    releaseSecond(); releaseSecond = () => {};
    await sync.mock.results[2]!.value;
    expect(sync).toHaveBeenCalledTimes(5);
    await sync.mock.results[4]!.value;
    expect(sync).toHaveBeenCalledTimes(5);
    expect(await t.cursor()).toEqual({ historyId: t.terminal });
    expect((await t.backend.store.accounts.get(t.account.id))?.syncState.status).toBe("idle");
    expect(t.requests.filter((u) => u.pathname === "/history").map((u) => u.searchParams.get("startHistoryId"))).toEqual([t.baseline, t.baseline, (BigInt(t.baseline) + 1n).toString()]);
    const rows = (await t.backend.store.debug.snapshot()).messages;
    expect(rows.find((m) => m.providerMsgId === "last")?.bodyText).toContain("Body last");
    await t.reopen();
    expect(await t.cursor()).toEqual({ historyId: t.terminal });
    expect((await t.backend.store.debug.snapshot()).messages.map((m) => m.providerMsgId).sort()).toEqual(["archive", "deleted", "last", "middle", "neighbor", "read"]);
  });
  it.each([false, true] as const)("freezes H1 with concurrent requests: %s", async (trigger) => {
    const t = await mailbox(kind); t.seed();
    const managed = t.context.google;
    expect(managed).toBeDefined();
    const requests = vi.spyOn(managed!, "request");
    await t.backend.syncAccount(t.account.id);
    expect(await t.cursor()).toEqual({ historyId: t.baseline });
    t.requests.length = 0;
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>((resolve) => { entered = resolve; });
    t.holdHistory((send) => { release = send; entered(); });
    const [local, remote] = createMemoryTransportPair();
    t.backend.connect(remote, { clientId: "synthetic", origin: "renderer" });
    const rpc = new RpcClient(local); cleanup.push(async () => { release?.(); rpc.close(); });
    const sync = vi.spyOn(t.backend, "syncAccount");
    const first = t.backend.syncAccount(t.account.id);
    await held;
    t.mutate();
    if (trigger) {
      await Promise.all([rpc.call("sync.now", { accountId: t.account.id }), rpc.call("sync.now", { accountId: t.account.id })]);
      expect(t.requests.filter((u) => u.pathname === "/history")).toHaveLength(1);
    }
    release(); release = () => {}; await first;
    await Promise.all(sync.mock.results.map((result) => result.value));
    expect(sync).toHaveBeenCalledTimes(trigger ? 4 : 1);
    if (trigger) {
      expect(await t.cursor()).toEqual({ historyId: t.terminal });
      expect((await t.backend.store.accounts.get(t.account.id))?.syncState.status).toBe("idle");
      expect(t.requests.filter((u) => u.pathname === "/history").map((u) => u.searchParams.get("pageToken"))).toEqual([null, null, "history/+?=next"]);
      await t.assertFinal();
    } else {
      expect(await t.cursor()).toEqual({ historyId: t.baseline });
      expect(t.requests.filter((u) => u.pathname === "/history")).toHaveLength(1);
      expect((await t.backend.store.debug.snapshot()).messages.map((m) => m.providerMsgId).sort()).toEqual(["archive", "deleted", "neighbor", "read"]);
    }
    expect(requests).toHaveBeenCalled();
    await t.reopen();
    if (trigger) await t.assertFinal();
    else expect(await t.cursor()).toEqual({ historyId: t.baseline });
  });
});
