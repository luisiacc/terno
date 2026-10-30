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

const phaseOf = (value: unknown) => (value as { reconciliation?: { stage: string; baseline?: string; pages?: number } } | null)?.reconciliation;
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

async function mailbox(kind: "SQL" | "IndexedDB") {
  const baseline = "90071992547409930000";
  let historyId = BigInt(baseline);
  const messages = new Map<string, { id: string; threadId: string; labelIds: string[]; raw: string }>();
  const history: { id: string; messagesAdded?: { message: { id: string } }[]; messagesDeleted?: { message: { id: string } }[]; labelsRemoved?: { message: { id: string } }[] }[] = [];
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
  let holdHistory: ((send: () => void) => void) | undefined;
  const add = (id: string, record = false) => {
    const raw = ["From: Synthetic <sender@example.test>", "To: me@example.test", `Subject: ${id}`, `Message-ID: <${id}@example.test>`,
      "MIME-Version: 1.0", 'Content-Type: multipart/mixed; boundary="b"', "", "--b", "Content-Type: text/plain", "", `Body ${id}`,
      "--b", "Content-Type: application/octet-stream", 'Content-Disposition: attachment; filename="exact.bin"', "Content-Transfer-Encoding: base64", "", "AP+ADQo=", "--b--", ""].join("\r\n");
    messages.set(id, { id, threadId: id, labelIds: ["INBOX", "UNREAD"], raw: Buffer.from(raw).toString("base64url") });
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
    if (url.pathname === "/labels") return json({ labels: [{ id: "Label_project", name: "Project", type: "user" }] });
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
      if (next !== null && next !== "history/+?=next") return json({}, 400);
      const payload = { historyId: String(historyId), history: entries.slice(next ? 2 : 0, next ? undefined : 2), ...(!next && entries.length > 2 && { nextPageToken: "history/+?=next" }) };
      const hold = holdHistory; holdHistory = undefined;
      if (hold) { hold(() => json(payload)); return; }
      return json(payload);
    }
    const id = url.pathname.replace("/messages/", "");
    if (getStatuses.has(id)) return json({}, getStatuses.get(id));
    if (id === "arrival" && rawStatus !== 200) return json({}, rawStatus);
    const message = messages.get(id);
    if (!message) return json({}, 404);
    return json(url.searchParams.get("format") === "raw" ? message : { id, labelIds: message.labelIds });
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
      const provider = createGmailApiProvider({ ...ctx, saveCursor: async (value) => { await ctx.saveCursor(value); await afterCheckpoint?.(value); } }, {
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
  const open = async () => new Backend({ dbPath: join(dir, "synthetic.db"), store: kind === "IndexedDB" ? await IdbMailStore.open({ name, factory, platform, instantSearch: false }) : undefined,
    platform, providers, now: () => now, cipher: plaintextCipher, version: "test", autoSync: false, instantSearch: false, iconTransport: null });
  let backend = await open();
  await backend.ready;
  const { account } = await backend.store.accounts.create({ kind: "gmail", email: "me@example.test", displayName: "Synthetic", color: "indigo", now: 1 });
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
    holdHistory(hook: (send: () => void) => void) { holdHistory = hook; },
    get backend() { return backend; }, get terminal() { return String(historyId); },
    afterIngest(hook: () => void | Promise<void>) { afterIngest = hook; }, afterCheckpoint(hook: (value: unknown) => void | Promise<void>) { afterCheckpoint = hook; },
    listStatus(status: number) { listStatus = status; }, nextToken(value: string) { nextToken = value; }, emptyFirst() { emptyFirst = true; }, repeatToken() { repeatToken = true; },
    getStatus(id: string, status: number) { if (status === 200) getStatuses.delete(id); else getStatuses.set(id, status); },
    advanceTime() { now += 86_400_000; },
    historyStatus(status: number) { historyStatus = status; }, rawStatus(status: number) { rawStatus = status; },
    seed() { for (const id of ["archive", "deleted", "read", "neighbor"]) add(id); },
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
  it.each(["initial", "expired"] as const)("catches page-one arrival/archive/delete/read races in the same %s invocation and survives reopen", async (path) => {
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

  it("accepts empty catch-up with a valid terminal ID in the same initial invocation", async () => {
    const t = await mailbox(kind);
    await t.backend.syncAccount(t.account.id);
    expect(t.requests.filter((u) => u.pathname === "/history").map((u) => u.searchParams.get("startHistoryId"))).toEqual([t.baseline]);
    expect(await t.cursor()).toEqual({ historyId: t.baseline });
    expect((await t.backend.store.accounts.get(t.account.id))?.syncState.status).toBe("idle");
    await t.reopen(); expect(await t.cursor()).toEqual({ historyId: t.baseline });
  });

  it("leaves an expired catch-up baseline for a later invocation, with no same-call reset loop or success", async () => {
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

  it.each([404, 503])("scopes catch-up raw-message %s to that resource without another full reconciliation", async (status) => {
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

  it("does not remove messages, checkpoint, or dispatch after cancellation following a flag write", async () => {
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

  it.each(["page", "baseline"] as const)("issues no later HTTP or checkpoint after cancellation at %s", async (boundary) => {
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


describe.each(["SQL", "IndexedDB"] as const)("%s Gmail durable enumeration", (kind) => {
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

  it("retains catch-up phase and the last completed history through a catch-up failure and reopen", async () => {
    const t = await mailbox(kind); t.seed(); t.afterIngest(t.mutate); t.historyStatus(503);
    await t.backend.store.accounts.setCursor(t.account.id, { historyId: "1" });
    await t.backend.syncAccount(t.account.id);
    const saved = await t.cursor();
    expect(saved).toMatchObject({ historyId: "1", reconciliation: { stage: "catchup", baseline: t.baseline } });
    await t.reopen(); expect(await t.cursor()).toEqual(saved); t.historyStatus(200); t.requests.length = 0;
    await t.backend.syncAccount(t.account.id); await t.assertFinal();
    expect(t.requests.filter((u) => u.pathname === "/messages" || u.pathname === "/profile")).toHaveLength(0);
  });

  it("never advances the page after a failed raw GET, and replays without duplicate ingestion", async () => {
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

  it("does not infer deletion from an empty list page", async () => {
    const t = await mailbox(kind); t.seed(); t.emptyFirst(); t.listStatus(503);
    await t.backend.syncAccount(t.account.id);
    expect(await t.cursor()).toMatchObject({ reconciliation: { next: "list/+?=next", pages: 1 } });
    await t.reopen(); t.listStatus(200);
    await t.backend.syncAccount(t.account.id);
    expect((await t.backend.store.debug.snapshot()).messages).toHaveLength(4);
    expect(await t.cursor()).toEqual({ historyId: t.baseline });
  });

  it.each([400, 404])("forgets an expired enumeration token (%s) and fails retryably without looping", async (status) => {
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

  it("refuses an oversized opaque token without saving or consuming it", async () => {
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

  it("cancellation after page effects does not advance the token and can resume on reopen", async () => {
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

  it.each(["window", "identity", "version"] as const)("restarts a persisted phase with changed %s rather than consuming its token", async (change) => {
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

  it("retains known messages until enumeration has completed and explicit refresh coverage validates deletion", async () => {
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

  it.each(["cycle", "limit"] as const)("bounds a persisted token %s across reopen without false completion", async (boundary) => {
    const t = await mailbox(kind); t.seed(); t.listStatus(503);
    await t.backend.syncAccount(t.account.id);
    const saved = await t.cursor() as { reconciliation: Record<string, unknown> };
    if (boundary === "limit") await t.backend.store.accounts.setCursor(t.account.id, { ...saved, reconciliation: { ...saved.reconciliation, pages: 10_000 } });
    else t.nextToken("list/+?=next");
    await t.reopen(); t.listStatus(200); t.requests.length = 0;
    if (boundary === "cycle") t.repeatToken();
    await t.backend.syncAccount(t.account.id);
    expect(t.requests.filter((u) => u.pathname === "/history")).toHaveLength(0);
    expect(await t.cursor()).toEqual({ reconciliation: { version: 1, stage: "restart" } });
    expect((await t.backend.store.accounts.get(t.account.id))?.syncState.status).not.toBe("idle");
  });


  it("refuses later refresh chunks after credentials change following the first committed chunk", async () => {
    const t = await mailbox(kind);
    for (let i = 0; i < 450; i++) t.add(`chunk-${i}`);
    const update = t.backend.store.sync.updateFlags.bind(t.backend.store.sync);
    const writes = vi.spyOn(t.backend.store.sync, "updateFlags").mockImplementation(async (...args) => {
      const result = await update(...args);
      if (t.backend.credentialsOf(t.account.id) === 0) await t.backend.signedIn(t.account.id);
      return result;
    });
    await t.backend.syncAccount(t.account.id);
    expect(writes).toHaveBeenCalledTimes(1);
    expect(writes.mock.calls[0]![1]).toHaveLength(200);
    expect(await t.cursor()).toMatchObject({ reconciliation: { stage: "refresh", baseline: t.baseline } });
    expect(t.requests.filter((u) => u.pathname === "/history")).toHaveLength(0);
    expect((await t.backend.store.accounts.get(t.account.id))?.syncState.lastSyncAt).toBeNull();
    writes.mockRestore(); await t.reopen(); t.requests.length = 0;
    await t.backend.syncAccount(t.account.id);
    expect(await t.cursor()).toEqual({ historyId: t.baseline });
    expect(t.requests.filter((u) => u.pathname === "/messages" || u.pathname === "/profile")).toHaveLength(0);
    expect((await t.backend.store.debug.snapshot()).messages).toHaveLength(450);
  });

  it("rechecks credentials after classifier preparation before admitting ingestion", async () => {
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


  it("does not publish a stale syncing state when credentials change during window preparation", async () => {
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


describe.each(["SQL", "IndexedDB"] as const)("%s managed Gmail concurrent public sync requests", (kind) => {
  it("does not spin after a failed trailing pass and a later request recovers", async () => {
    const t = await mailbox(kind); t.seed(); await t.backend.syncAccount(t.account.id); t.requests.length = 0;
    const [local, remote] = createMemoryTransportPair();
    t.backend.connect(remote, { clientId: "synthetic", origin: "renderer" });
    const rpc = new RpcClient(local); let release = () => {}, entered!: () => void;
    const held = new Promise<void>((resolve) => { entered = resolve; });
    cleanup.push(async () => { release(); rpc.close(); });
    t.holdHistory((send) => { release = send; entered(); });
    const first = t.backend.syncAccount(t.account.id); await held;
    t.mutate(); await rpc.call("sync.now", { accountId: t.account.id });
    t.historyStatus(503); release(); release = () => {}; await first;
    await expect.poll(() => t.requests.filter((u) => u.pathname === "/history").length).toBe(2);
    await expect.poll(async () => (await t.backend.store.accounts.get(t.account.id))?.syncState.lastError).toBeTruthy();
    for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    expect(t.requests.filter((u) => u.pathname === "/history")).toHaveLength(2);
    expect(await t.cursor()).toEqual({ historyId: t.baseline });
    t.historyStatus(200);
    await t.backend.syncAccount(t.account.id);
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
    const first = t.backend.syncAccount(t.account.id); await firstEntered;
    t.add("middle", true);
    await rpc.call("sync.now", { accountId: t.account.id });
    t.holdHistory((send) => { releaseSecond = send; enterSecond(); });
    releaseFirst(); releaseFirst = () => {}; await first; await secondEntered;
    t.add("last", true);
    await rpc.call("sync.now", { accountId: t.account.id });
    expect(t.requests.filter((u) => u.pathname === "/history")).toHaveLength(2);
    releaseSecond(); releaseSecond = () => {};
    await expect.poll(async () => (await t.cursor() as { historyId?: string })?.historyId).toBe(t.terminal);
    await expect.poll(async () => (await t.backend.store.accounts.get(t.account.id))?.syncState.status).toBe("idle");
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
    const first = t.backend.syncAccount(t.account.id);
    await held;
    t.mutate();
    if (trigger) {
      await Promise.all([rpc.call("sync.now", { accountId: t.account.id }), rpc.call("sync.now", { accountId: t.account.id })]);
      expect(t.requests.filter((u) => u.pathname === "/history")).toHaveLength(1);
    }
    release(); release = () => {}; await first;
    if (trigger) {
      await expect.poll(async () => (await t.cursor() as { historyId?: string })?.historyId).toBe(t.terminal);
      await expect.poll(async () => (await t.backend.store.accounts.get(t.account.id))?.syncState.status).toBe("idle");
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
