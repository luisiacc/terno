import "fake-indexeddb/auto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IDBFactory } from "fake-indexeddb";
import { IdbMailStore } from "@terno/idb";
import { createGmailApiProvider, type ProviderRegistry } from "@terno/mail/portable";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Backend, plaintextCipher } from "./backend";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  try { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); }
  finally { vi.restoreAllMocks(); vi.unstubAllGlobals(); }
});

async function setup(kind: "SQL" | "IDB") {
  const dir = mkdtempSync(join(tmpdir(), "terno-w02-tuple-"));
  const factory = new IDBFactory(), name = crypto.randomUUID();
  const platform = { uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((resolve) => setImmediate(resolve)) };
  const remote = new Map(["target", "sibling"].map((id) => [id, new Set(["INBOX", "STARRED"])]));
  const mutations: { ids: string[]; add: string[]; remove: string[] }[] = [];
  const unexpected: string[] = [];
  const raw = Buffer.from("From: sender@example.test\r\nTo: synthetic@example.test\r\nSubject: Synthetic\r\n\r\nExact body\r\n").toString("base64url");
  let history = 10;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url), path = url.pathname;
    if (url.origin !== "http://127.0.0.1" || !path.startsWith("/fixture/")) {
      unexpected.push("origin"); throw new Error("Unexpected fixture origin");
    }
    if (req.method === "GET" && path === "/fixture/labels") return Response.json({ labels: [] });
    if (req.method === "GET" && path === "/fixture/profile") return Response.json({ emailAddress: "synthetic@example.test", historyId: String(history) });
    if (req.method === "GET" && path === "/fixture/messages") return Response.json({ messages: [...remote.keys()].map((id) => ({ id })) });
    if (req.method === "GET" && path === "/fixture/history") return Response.json({ historyId: String(history), history: [{ labelsAdded: [...remote.keys()].map((id) => ({ message: { id } })) }] });
    const id = path.split("/").at(-1)!;
    if (req.method === "GET" && path.startsWith("/fixture/messages/") && remote.has(id)) return Response.json({ id, threadId: `thread-${id}`, labelIds: [...remote.get(id)!], historyId: String(history), ...(url.searchParams.get("format") === "raw" ? { raw } : {}) });
    if (req.method === "POST" && path === "/fixture/messages/target/trash") {
      remote.get("target")!.add("TRASH"); remote.get("target")!.delete("INBOX"); history++;
      mutations.push({ ids: ["target"], add: ["TRASH"], remove: ["INBOX"] });
      return Response.json({ id: "target" });
    }
    if (req.method === "POST" && path === "/fixture/messages/batchModify") {
      const body = await req.json() as { ids: string[]; addLabelIds: string[]; removeLabelIds: string[] };
      expect(body.ids.every((target) => remote.has(target))).toBe(true);
      mutations.push({ ids: body.ids, add: body.addLabelIds, remove: body.removeLabelIds });
      for (const target of body.ids) {
        for (const label of body.addLabelIds) remote.get(target)!.add(label);
        for (const label of body.removeLabelIds) remote.get(target)!.delete(label);
      }
      history++;
      return new Response(null, { status: 204 });
    }
    unexpected.push(`${req.method} ${path}`); throw new Error("Unexpected fixture route");
  });
  const providers: ProviderRegistry = {
    create(ctx) { return createGmailApiProvider(ctx, { endpoints: { api: "http://127.0.0.1/fixture" }, tokens: { get: async () => "synthetic", invalidate() {} }, buildRaw: async () => new Uint8Array() }); },
    async verifyImap() {}, async connectGmail() { throw new Error("Unused fixture consent"); },
  };
  const open = async () => {
    const store = kind === "IDB" ? await IdbMailStore.open({ name, factory, platform, instantSearch: false }) : undefined;
    const b = new Backend({ dbPath: join(dir, "synthetic.db"), store, platform, providers, cipher: plaintextCipher, version: "test", autoSync: false, instantSearch: false, iconTransport: null });
    vi.spyOn(b, "kickWorker").mockImplementation(() => {});
    await b.ready;
    return b;
  };
  let backend = await open();
  let client: RpcClient;
  const attach = () => {
    const [c, s] = createMemoryTransportPair(); backend.connect(s, { clientId: "synthetic", origin: "renderer" }); client = new RpcClient(c); return client;
  };
  attach();
  cleanups.push(async () => { client.close(); await backend.stop(); rmSync(dir, { recursive: true, force: true }); expect(unexpected).toEqual([]); });
  const { account } = await backend.store.accounts.create({ kind: "gmail", email: "synthetic@example.test", displayName: "Synthetic", color: "indigo", now: 1 });
  await backend.syncAccount(account.id);
  expect((await backend.store.accounts.get(account.id))?.syncState).toMatchObject({ status: "idle", lastError: null });
  const snapshot = await backend.store.debug.snapshot();
  const target = snapshot.messages.find((m) => m.providerMsgId === "target")!;
  const sibling = snapshot.messages.find((m) => m.providerMsgId === "sibling")!;
  return { get backend() { return backend; }, get client() { return client; }, target, sibling, remote, mutations, account,
    async reopen() { client.close(); await backend.stop(); backend = await open(); attach(); },
  };
}

describe.each(["SQL", "IDB"] as const)("W02 supported saved tuple: %s", (kind) => {
  it.each([false, true])("Undo restores saved Trash with secondary Spam=%s after queued correction reopens", async (spam) => {
    const t = await setup(kind);
    const act = (action: "trash" | "spam" | "moveToInbox") => t.client.call("threads.act", { threadIds: [t.target.threadId], action });
    await act("trash"); expect(await t.backend.runWorker()).toBe(1);
    if (spam) { await act("spam"); expect(await t.backend.runWorker()).toBe(1); }
    const expected = ["STARRED", "TRASH", ...(spam ? ["SPAM"] : [])].sort();
    expect([...t.remote.get("target")!].sort()).toEqual(expected);
    const saved = (await t.backend.store.debug.snapshot()).messages.find((m) => m.id === t.target.id)!;
    const restore = await act("moveToInbox"); expect(await t.backend.runWorker()).toBe(1);
    expect([...t.remote.get("target")!].sort()).toEqual(["INBOX", "STARRED"]);
    expect(await t.client.call("threads.undo", { undoId: restore.undoId! })).toEqual({ restored: 1 });
    const queued = (await t.backend.store.debug.snapshot()).ops.filter((op) => op.state === "queued");
    expect(queued.length).toBeGreaterThan(0);
    for (const op of queued) expect(op.messageIds).toEqual([t.target.id]);
    expect((await t.backend.store.debug.snapshot()).messages.find((m) => m.id === t.target.id)).toMatchObject({ inInbox: false, isTrash: true, isSpam: spam, isRead: true, isStarred: true });
    await t.reopen();
    expect((await t.backend.store.debug.snapshot()).ops.filter((op) => op.state === "queued")).toEqual(queued);
    expect(await t.backend.runWorker()).toBe(queued.length);
    await t.backend.syncAccount(t.account.id);
    expect((await t.backend.store.accounts.get(t.account.id))?.syncState).toMatchObject({ status: "idle", lastError: null });
    const after = await t.backend.store.debug.snapshot();
    expect.soft([...t.remote.get("target")!].sort()).toEqual(expected);
    expect.soft(after.messages.find((m) => m.id === t.target.id)).toMatchObject({ inInbox: saved.inInbox, isTrash: saved.isTrash, isSpam: saved.isSpam, isRead: saved.isRead, isStarred: saved.isStarred });
    expect(after.messages.find((m) => m.id === t.sibling.id)).toEqual(t.sibling);
    expect([...t.remote.get("sibling")!].sort()).toEqual(["INBOX", "STARRED"]);
    expect(t.mutations.every((mutation) => mutation.ids.length === 1 && mutation.ids[0] === "target")).toBe(true);
    expect(after.ops.every((op) => op.state === "succeeded" && op.attempts === 1)).toBe(true);
    expect((await t.backend.store.providerStore(t.account.id).pendingFlagSnapshots({ limit: 50 })).items).toEqual([]);
    await t.backend.store.debug.verify();
  });
  it("Undo preserves canonical Spam-only membership through reconciliation", async () => {
    const t = await setup(kind);
    for (const action of ["spam"] as const) {
      await t.client.call("threads.act", { threadIds: [t.target.threadId], action });
      expect(await t.backend.runWorker()).toBe(1);
    }
    expect([...t.remote.get("target")!].sort()).toEqual(["SPAM", "STARRED"]);
    const restored = await t.client.call("threads.act", { threadIds: [t.target.threadId], action: "moveToInbox" });
    expect(await t.backend.runWorker()).toBe(1);
    expect(await t.client.call("threads.undo", { undoId: restored.undoId! })).toEqual({ restored: 1 });
    const correction = (await t.backend.store.debug.snapshot()).ops.filter((op) => op.state === "queued");
    for (const op of correction) expect(op.messageIds).toEqual([t.target.id]);
    await t.reopen();
    expect(await t.backend.runWorker()).toBe(correction.length);
    await t.backend.syncAccount(t.account.id);
    expect([...t.remote.get("target")!].sort()).toEqual(["SPAM", "STARRED"]);
    const after = await t.backend.store.debug.snapshot();
    expect(after.messages.find((m) => m.id === t.target.id)).toMatchObject({ inInbox: false, isTrash: false, isSpam: true, isRead: true, isStarred: true });
    expect(after.messages.find((m) => m.id === t.sibling.id)).toEqual(t.sibling);
    expect(after.ops.every((op) => op.state === "succeeded" && op.attempts === 1)).toBe(true);
    expect(t.mutations.every((mutation) => mutation.ids.length === 1 && mutation.ids[0] === "target")).toBe(true);
    expect((await t.backend.store.providerStore(t.account.id).pendingFlagSnapshots({ limit: 50 })).items).toEqual([]);
  });

});
