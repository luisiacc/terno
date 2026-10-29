import "fake-indexeddb/auto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IdbMailStore } from "@terno/idb";
import { IDBFactory } from "fake-indexeddb";
import { createGmailApiProvider, type ProviderRegistry } from "@terno/mail/portable";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Backend, plaintextCipher } from "./backend";

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
  const abort = new AbortController();
  const requests: URL[] = [], ingested: { id: string; live: boolean }[] = [];
  let afterIngest: (() => void) | undefined;
  let afterCheckpoint: (() => void) | undefined;
  let historyStatus = 200, rawStatus = 200;
  let snapshot: string[] = [];
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
    if (url.pathname === "/profile") return json({ historyId: String(historyId) });
    if (url.pathname === "/labels") return json({ labels: [{ id: "Label_project", name: "Project", type: "user" }] });
    if (url.pathname === "/messages") {
      if (!url.searchParams.has("pageToken")) snapshot = [...messages.keys()];
      const next = url.searchParams.get("pageToken");
      if (next !== null && next !== "list/+?=next") return json({}, 400);
      return json({ historyId: "90071992547409939999", messages: snapshot.slice(next ? 3 : 0, next ? undefined : 3).map((id) => ({ id })), ...(!next && snapshot.length > 3 && { nextPageToken: "list/+?=next" }) });
    }
    if (url.pathname === "/history") {
      if (url.searchParams.get("startHistoryId") === "1") return json({}, 404);
      if (historyStatus !== 200) return json({}, historyStatus);
      const entries = history.filter((h) => BigInt(h.id) > BigInt(url.searchParams.get("startHistoryId")!));
      const next = url.searchParams.get("pageToken");
      if (next !== null && next !== "history/+?=next") return json({}, 400);
      return json({ historyId: String(historyId), history: entries.slice(next ? 2 : 0, next ? undefined : 2), ...(!next && entries.length > 2 && { nextPageToken: "history/+?=next" }) });
    }
    const id = url.pathname.replace("/messages/", "");
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
      const provider = createGmailApiProvider({ ...ctx, saveCursor: async (value) => { await ctx.saveCursor(value); afterCheckpoint?.(); } }, {
        endpoints: { api }, tokens: { get: async () => "synthetic", invalidate() {} }, buildRaw: async () => new Uint8Array(),
      });
      return { ...provider, sync: (sink) => provider.sync({ ...sink, signal: AbortSignal.any([sink.signal, abort.signal]), ingest: async (batch, options) => {
        await sink.ingest(batch, options);
        ingested.push(...batch.map((m) => ({ id: m.providerMsgId!, live: options?.live === true })));
        if (ingested.length >= 3) { const hook = afterIngest; afterIngest = undefined; hook?.(); }
      } }) };
    },
    async verifyImap() {}, async connectGmail() { throw new Error("Unused synthetic consent"); },
  };
  const open = async () => new Backend({ dbPath: join(dir, "synthetic.db"), store: kind === "IndexedDB" ? await IdbMailStore.open({ name, factory, platform, instantSearch: false }) : undefined,
    platform, providers, cipher: plaintextCipher, version: "test", autoSync: false, instantSearch: false, iconTransport: null });
  let backend = await open();
  await backend.ready;
  const { account } = await backend.store.accounts.create({ kind: "gmail", email: "me@example.test", displayName: "Synthetic", color: "indigo", now: 1 });
  cleanup.push(async () => {
    try { await backend.stop(); }
    finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
  });
  const cursor = async () => (await backend.store.accounts.config<{ cursor?: unknown }>(account.id))?.config.cursor;
  return {
    baseline, account, requests, ingested, messages, add, mutate, cursor, abort,
    get backend() { return backend; }, get terminal() { return String(historyId); },
    afterIngest(hook: () => void) { afterIngest = hook; }, afterCheckpoint(hook: () => void) { afterCheckpoint = hook; },
    historyStatus(status: number) { historyStatus = status; }, rawStatus(status: number) { rawStatus = status; },
    seed() { for (const id of ["archive", "deleted", "read", "neighbor"]) add(id); },
    async reopen() { await backend.stop(); backend = await open(); await backend.ready; },
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
      if (!refused && (value as { historyId: string }).historyId === (checkpoint === "baseline" ? t.baseline : t.terminal)) { refused = true; throw new Error("Synthetic checkpoint failure"); }
      return setCursor(id, value);
    });
    await t.backend.syncAccount(t.account.id);
    expect(refused).toBe(true);
    expect(await t.cursor()).toEqual(checkpoint === "baseline" ? undefined : { historyId: t.baseline });
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
    const t = await mailbox(kind); t.seed(); t.afterIngest(t.mutate);
    const write = vi.spyOn(t.backend.store.sync, effect).mockRejectedValueOnce(new Error("Synthetic effect failure"));
    await t.backend.syncAccount(t.account.id);
    expect(write).toHaveBeenCalled();
    expect(await t.cursor()).toEqual({ historyId: t.baseline });
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
    expect(await t.cursor()).toEqual({ historyId: t.baseline });
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
    expect(await t.cursor()).toEqual({ historyId: status === 404 ? t.terminal : t.baseline });
    if (status === 503) {
      t.rawStatus(200); await t.reopen();
      await t.backend.syncAccount(t.account.id); await t.assertFinal();
    } else {
      expect((await t.backend.store.debug.snapshot()).messages.map((m) => m.providerMsgId).sort()).toEqual(["archive", "neighbor", "read"]);
      expect((await t.backend.store.accounts.get(t.account.id))?.syncState.status).toBe("idle");
    }
  });

  it("does not remove messages, checkpoint, or dispatch after cancellation following a flag write", async () => {
    const t = await mailbox(kind); t.seed(); t.afterIngest(t.mutate);
    const update = t.backend.store.sync.updateFlags.bind(t.backend.store.sync);
    let at = -1;
    vi.spyOn(t.backend.store.sync, "updateFlags").mockImplementation(async (...args) => {
      const result = await update(...args);
      at = t.requests.length;
      t.abort.abort(new Error("Synthetic cancellation after flag write"));
      return result;
    });
    await t.backend.syncAccount(t.account.id);
    expect(t.abort.signal.aborted).toBe(true);
    expect(t.requests).toHaveLength(at);
    expect(await t.cursor()).toEqual({ historyId: t.baseline });
    expect((await t.backend.store.debug.snapshot()).messages.some((m) => m.providerMsgId === "deleted")).toBe(true);
    expect((await t.backend.store.accounts.get(t.account.id))?.syncState.status).not.toBe("idle");
  });

  it.each(["page", "baseline"] as const)("issues no later HTTP or checkpoint after cancellation at %s", async (boundary) => {
    const t = await mailbox(kind); t.seed();
    if (boundary === "page") t.afterIngest(() => t.abort.abort(new Error("Synthetic cancellation")));
    else t.afterCheckpoint(() => t.abort.abort(new Error("Synthetic cancellation")));
    await t.backend.syncAccount(t.account.id);
    expect(t.abort.signal.aborted).toBe(true);
    expect(t.requests.filter((u) => u.pathname === "/history")).toEqual([]);
    expect(t.requests.filter((u) => u.pathname === "/messages")).toHaveLength(boundary === "page" ? 1 : 2);
    expect(await t.cursor()).toEqual(boundary === "page" ? undefined : { historyId: t.baseline });
    expect((await t.backend.store.accounts.get(t.account.id))?.syncState.status).not.toBe("idle");
  });
});
