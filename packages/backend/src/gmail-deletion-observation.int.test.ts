import "fake-indexeddb/auto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { IdbMailStore } from "@terno/idb";
import { IDBFactory } from "fake-indexeddb";
import { createGmailApiProvider, type ProviderRegistry } from "@terno/mail/portable";
import { processIncoming } from "@terno/mail/incoming-processing-worker";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Backend, plaintextCipher } from "./backend";

const base = "90071992547409930000", terminal = "90071992547409930003";
const api = "https://gmail.googleapis.com/gmail/v1/users/me";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { try { for (const close of cleanup.splice(0).reverse()) await close(); } finally { vi.restoreAllMocks(); } });
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
function wire(id: string) {
  return Buffer.from(["From: sender@example.test", "To: me@example.test", "Subject: Shared", `Message-ID: <${id}@example.test>`,
    ...(id === "b" ? ["In-Reply-To: <a@example.test>"] : []), "MIME-Version: 1.0", 'Content-Type: multipart/mixed; boundary="b"', "", "--b", "Content-Type: text/plain", "", `Exact body ${id}`,
    "--b", "Content-Type: application/octet-stream", `Content-Disposition: attachment; filename="${id}.bin"`, "Content-Transfer-Encoding: base64", "", id === "a" ? "AP+ADQo=" : "AQIDBA==", "--b--", ""].join("\r\n")).toString("base64url");
}
async function mailbox(kind: "SQL" | "IndexedDB") {
  const messages = new Map(["a", "b"].map((id) => [id, { id, threadId: "shared", labelIds: ["INBOX", "UNREAD"], internalDate: "1", raw: wire(id) }]));
  const requests: URL[] = [], unexpected: string[] = [];
  let deleted = false, omit = false, profile404 = false;
  let hold: { id: string; format: string; entered: ReturnType<typeof gate>; release: ReturnType<typeof gate>; settled: ReturnType<typeof gate> } | undefined;
  const transport = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const refuse = (): never => { unexpected.push("Unexpected synthetic Gmail route"); throw new Error(unexpected.at(-1)); };
    if (!(input instanceof Request) || init !== undefined || input.method !== "GET" || input.redirect !== "error" || input.headers.get("authorization") !== "Bearer synthetic") return refuse();
    const url = new URL(input.url);
    if (url.origin !== new URL(api).origin || !url.pathname.startsWith(`${new URL(api).pathname}/`)) return refuse();
    requests.push(url);
    const path = url.pathname.slice(new URL(api).pathname.length);
    if (path === "/profile" && !url.search) return profile404 ? Response.json({}, { status: 404 }) : Response.json({ emailAddress: "me@example.test", historyId: base });
    if (path === "/labels" && !url.search) return Response.json({ labels: [] });
    if (path === "/messages" && url.searchParams.size === 3 && url.searchParams.get("includeSpamTrash") === "true" && url.searchParams.get("maxResults") === "500" && /^after:\d+$/.test(url.searchParams.get("q") ?? "")) return Response.json({ messages: [...messages.keys()].filter((id) => !omit || id !== "b").map((id) => ({ id })) });
    if (path === "/history") {
      const start = url.searchParams.get("startHistoryId"), next = url.searchParams.get("pageToken");
      if (url.searchParams.get("maxResults") !== "500" || url.searchParams.getAll("historyTypes").sort().join(",") !== "labelAdded,labelRemoved,messageAdded,messageDeleted" || url.searchParams.size !== (next ? 7 : 6)) return refuse();
      if (start === "1") return Response.json({}, { status: 404 });
      if (start !== base && start !== terminal) return refuse();
      if (!deleted || start === terminal) return Response.json({ historyId: deleted ? terminal : base });
      if (next === null) return Response.json({ historyId: terminal, history: [{ id: "90071992547409930001", messagesAdded: [{ message: { id: "b" } }], labelsAdded: [{ message: { id: "b" }, labelIds: ["STARRED"] }] }], nextPageToken: "delete-next" });
      if (next !== "delete-next") return refuse();
      return Response.json({ historyId: terminal, history: [{ id: "90071992547409930002", messagesDeleted: [{ message: { id: "b" } }] }] });
    }
    const id = path.slice("/messages/".length), format = url.searchParams.get("format");
    if (!path.startsWith("/messages/") || !["a", "b"].includes(id) || url.searchParams.size !== 1 || (format !== "raw" && format !== "minimal")) return refuse();
    const message = messages.get(id);
    // Freeze the bytes before the owner changes, not when the gate is released.
    const response = message ? Response.json(format === "raw" ? message : { id, labelIds: message.labelIds }) : Response.json({}, { status: 404 });
    const held = hold;
    if (held?.id === id && held.format === format) {
      hold = undefined; held.entered.release();
      await held.release.promise; held.settled.release();
    }
    return response;
  });
  const dir = mkdtempSync(join(tmpdir(), "terno-deletion-")), factory = new IDBFactory(), name = crypto.randomUUID();
  const platform = { uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((resolve) => setImmediate(resolve)) };
  const providers: ProviderRegistry = {
    create: (ctx) => createGmailApiProvider(ctx, { tokens: { get: async () => "synthetic", invalidate() {} }, buildRaw: async () => new Uint8Array() }),
    async verifyImap() {}, async connectGmail() { throw new Error("Unused synthetic consent"); },
  };
  const open = async () => new Backend({ dbPath: join(dir, "synthetic.db"), store: kind === "IndexedDB" ? await IdbMailStore.open({ name, factory, platform, instantSearch: false }) : undefined,
    incomingProcessor: { async run(input, signal) { signal.throwIfAborted(); const result = await processIncoming(input); signal.throwIfAborted(); return result; }, async whenIdle() {}, async close() {} },
    platform, providers, cipher: plaintextCipher, version: "test", autoSync: false, instantSearch: false, iconTransport: null });
  let backend = await open(); await backend.ready;
  const { account } = await backend.store.accounts.create({ kind: "gmail", email: "me@example.test", displayName: "Synthetic", color: "indigo", now: 1 });
  const clients: RpcClient[] = [], runs: Promise<void>[] = [], held: NonNullable<typeof hold>[] = [];
  const rpc = () => { const [local, remote] = createMemoryTransportPair(); backend.connect(remote, { clientId: "synthetic", origin: "renderer" }); const client = new RpcClient(local); clients.push(client); return client; };
  cleanup.push(async () => {
    for (const h of held) h.release.release();
    await Promise.allSettled(runs);
    for (const client of clients) client.close();
    try { expect(unexpected).toEqual([]); expect(backend.net.googlePending()).toBe(0); } finally { await backend.stop(); rmSync(dir, { recursive: true, force: true }); }
  });
  const cursor = async () => (await backend.store.accounts.config<{ cursor?: unknown }>(account.id))?.config.cursor;
  const rows = async () => (await backend.store.debug.snapshot()).messages;
  return {
    account, messages, requests, transport, unexpected, cursor, rows, rpc,
    get backend() { return backend; },
    sync() { const run = backend.syncAccount(account.id); runs.push(run); return run; },
    deleteB() { deleted = true; messages.delete("b"); }, omitB() { omit = true; }, profileMissing() { profile404 = true; },
    hold(id: string, format: string) { const h = { id, format, entered: gate(), release: gate(), settled: gate() }; held.push(h); hold = h; return h; },
    async reopen() { await backend.stop(); backend = await open(); await backend.ready; },
    async asset(messageId: number) { const attachments = await backend.store.attachments.current(account.id, { id: messageId }); expect(attachments).toHaveLength(1); return { attachments, bytes: await backend.store.attachments.read(account.id, attachments[0]!.assetId!, 0) }; },
  };
}

describe.each(["SQL", "IndexedDB"] as const)("%s managed Gmail deletion observation", (kind) => {
  it("replays partial-thread deletion before a failed cursor without resurrecting old add/label history", async () => {
    const t = await mailbox(kind); await t.sync();
    const before = await t.rows(), a = before.find((m) => m.providerMsgId === "a")!, b = before.find((m) => m.providerMsgId === "b")!;
    expect(a.threadId).toBe(b.threadId); expect(await t.asset(a.id)).toMatchObject({ bytes: "AP+ADQo=" }); expect(await t.asset(b.id)).toMatchObject({ bytes: "AQIDBA==" });
    const intent = await t.backend.store.threads.act({ threadIds: [a.threadId], action: "archive", signal: null, now: Date.now() });
    expect(intent.opIds).toHaveLength(1);
    expect(JSON.parse((await t.backend.store.ops.get(intent.opIds[0]!))!.target_json)).toEqual({ messageIds: [a.id, b.id] });
    const survivor = (await t.rows()).find((m) => m.id === a.id)!, asset = await t.asset(a.id);
    t.deleteB(); t.requests.length = 0;
    const save = t.backend.store.accounts.setCursor.bind(t.backend.store.accounts);
    const failure = vi.spyOn(t.backend.store.accounts, "setCursor").mockImplementation(async (id, value, ...rest) => {
      if ((value as { historyId?: string }).historyId === terminal) throw new Error("Synthetic pre-commit checkpoint failure");
      return save(id, value, ...rest);
    });
    await t.sync(); expect(failure).toHaveBeenCalled(); expect(await t.cursor()).toEqual({ historyId: base });
    const assertSurvivor = async () => {
      expect(await t.rows()).toEqual([survivor]);
      expect(await t.asset(a.id)).toEqual(asset);
      expect(await t.backend.store.attachments.current(t.account.id, { id: b.id })).toEqual([]);
      const detail = await t.backend.store.threads.get(a.threadId); expect(detail?.messages.map((m) => m.id)).toEqual([a.id]);
      const summaries = await t.backend.store.threads.summaries([a.threadId]); expect(summaries[0]?.messageCount).toBe(1);
      const ops = (await t.backend.store.debug.snapshot()).ops; expect(ops).toHaveLength(1); expect(ops[0]).toMatchObject({ state: "queued" }); expect(ops[0]!.messageIds).toEqual([a.id]);
    };
    await assertSurvivor(); failure.mockRestore(); await t.reopen(); await assertSurvivor(); await t.sync(); await assertSurvivor();
    expect(await t.cursor()).toEqual({ historyId: terminal });
    expect(t.requests.filter((u) => u.pathname.endsWith("/messages/b"))).toEqual([]);
    expect(t.requests.filter((u) => u.pathname.endsWith("/history")).map((u) => [u.searchParams.get("startHistoryId"), u.searchParams.get("pageToken")])).toEqual([[base, null], [base, "delete-next"], [base, null], [base, "delete-next"]]);
    await t.reopen(); await t.sync(); await assertSurvivor(); expect(await t.cursor()).toEqual({ historyId: terminal });
  });

  it.each(["raw", "minimal"] as const)("rejects frozen %s completion from retired credentials after a newer deletion", async (format) => {
    const t = await mailbox(kind); await t.sync();
    const original = await t.rows(), a = original.find((m) => m.providerMsgId === "a")!, asset = await t.asset(a.id);
    let b = original.find((m) => m.providerMsgId === "b")!;
    // Force a legitimate raw enumeration or minimal refresh without changing cached data.
    await t.backend.store.accounts.setCursor(t.account.id, { historyId: "1" });
    if (format === "raw") {
      // Seed the supported legacy cache shape: body present, attachment capture still owed.
      await t.backend.store.sync.remove([b.id]);
      await t.backend.ingestSliced([{ accountId: t.account.id, providerMsgId: "b", providerThreadId: "shared", rfcMessageId: "b@example.test", inReplyTo: "a@example.test", references: [], from: { name: "", email: "sender@example.test" }, to: [], cc: [], bcc: [], subject: "Shared", date: 1, snippet: "", bodyText: "Legacy cached body", bodyHtml: null, bodyState: "full", listId: null, isRead: false, isStarred: false, inInbox: true, isSent: false, isDraft: false, isTrash: false, isSpam: false, hasAttachments: true, size: 5 }]);
      b = (await t.rows()).find((m) => m.providerMsgId === "b")!;
      expect(await t.backend.store.providerStore(t.account.id).pendingAttachmentBodies(50)).toEqual([{ id: b.id, providerMsgId: "b" }]);
      await t.backend.store.accounts.setCursor(t.account.id, { historyId: base });
    }
    const held = t.hold("b", format), old = t.sync(); await held.entered.promise;
    await t.backend.dropAccount(t.account.id); await t.backend.signedIn(t.account.id);
    t.deleteB(); await t.backend.store.accounts.setCursor(t.account.id, { historyId: base }); await t.sync();
    const fresh = await t.rows(); expect(fresh).toEqual([a]); expect(await t.cursor()).toEqual({ historyId: terminal });
    held.release.release(); await held.settled.promise; await old;
    expect(await t.cursor()).toEqual({ historyId: terminal });
    expect(await t.rows()).toEqual(fresh); expect(await t.asset(a.id)).toEqual(asset); expect(await t.backend.store.attachments.current(t.account.id, { id: b.id })).toEqual([]);
    await t.reopen(); expect(await t.cursor()).toEqual({ historyId: terminal }); await t.sync(); expect(await t.rows()).toEqual(fresh); expect(await t.cursor()).toEqual({ historyId: terminal });
  });

  it("does not infer deletion from window omission, but a resource404 removes only its message", async () => {
    const t = await mailbox(kind); await t.sync(); const original = await t.rows(); t.omitB();
    await t.backend.store.accounts.setCursor(t.account.id, { historyId: "1" }); await t.sync(); expect(await t.rows()).toEqual(original);
    expect(t.requests.some((u) => u.pathname.endsWith("/messages/b") && u.searchParams.get("format") === "minimal")).toBe(true);
    t.messages.delete("b"); await t.backend.store.accounts.setCursor(t.account.id, { historyId: "1" }); await t.sync();
    const a = original.find((m) => m.providerMsgId === "a")!; expect(await t.rows()).toEqual([a]); expect(await t.cursor()).toEqual({ historyId: base });
    await t.reopen(); await t.sync(); expect(await t.rows()).toEqual([a]); expect(await t.asset(a.id)).toMatchObject({ bytes: "AP+ADQo=" });
    t.messages.delete("a"); await t.backend.store.accounts.setCursor(t.account.id, { historyId: "1" }); await t.sync(); expect(await t.rows()).toEqual([]); expect(await t.backend.store.threads.get(a.threadId)).toBeNull();
    await t.reopen(); await t.sync(); expect(await t.rows()).toEqual([]);
  });

  it("rejects a frozen raw completion after public account removal", async () => {
    const t = await mailbox(kind), held = t.hold("b", "raw"), old = t.sync(); await held.entered.promise;
    await t.rpc().call("accounts.remove", { id: t.account.id });
    held.release.release(); await held.settled.promise; await old;
    expect(await t.backend.store.accounts.get(t.account.id)).toBeNull(); expect(await t.rows()).toEqual([]); expect(await t.cursor()).toBeUndefined();
    await t.reopen(); expect(await t.rows()).toEqual([]); expect(await t.backend.store.accounts.get(t.account.id)).toBeNull();
  });

  it("profile404 cannot delete cached messages or promote a cursor", async () => {
    const t = await mailbox(kind); await t.sync(); const original = await t.rows(); await t.reopen(); await t.backend.store.accounts.setCursor(t.account.id, { historyId: "1" }); t.profileMissing(); t.requests.length = 0;
    await t.sync(); expect(await t.rows()).toEqual(original); expect(await t.cursor()).toEqual({ historyId: "1" });
    expect(t.requests.map((u) => u.pathname)).toEqual([`${new URL(api).pathname}/history`, `${new URL(api).pathname}/profile`]);
    expect((await t.backend.store.accounts.get(t.account.id))?.syncState.status).not.toBe("idle");
  });
});
