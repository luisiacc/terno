import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import "fake-indexeddb/auto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IdbMailStore } from "@terno/idb";
import { IDBFactory } from "fake-indexeddb";
import { createGmailApiProvider, type ProviderRegistry } from "../../mail/src/portable";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Backend, plaintextCipher } from "../../backend/src/backend";
import { createNodeIncomingProcessor } from "../../backend/src/incoming-worker";

const base = "90071992547409930000", terminal = "90071992547409930003";
const api = "https://gmail.googleapis.com/gmail/v1/users/me";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { try { for (const close of cleanup.splice(0).reverse()) await close(); } finally { vi.restoreAllMocks(); } });
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
function resource(id: string, files = 1) {
  const parts = Array.from({ length: files }, (_, index) => ["--b", "Content-Type: application/octet-stream", `Content-Disposition: attachment; filename="${index}.bin"`, "Content-Transfer-Encoding: base64", "", "AP+ADQo="].join("\r\n"));
  const raw = ["From: sender@example.test", "To: me@example.test", "Subject: Shared", `Message-ID: <${id}@example.test>`, "MIME-Version: 1.0", 'Content-Type: multipart/mixed; boundary="b"', "", "--b", "Content-Type: text/plain", "", `Exact body ${id}`, ...parts, "--b--", ""].join("\r\n");
  return { id, threadId: "shared", labelIds: ["INBOX", "UNREAD"], internalDate: "1", raw: Buffer.from(raw).toString("base64url") };
}

it("the emitted worker refuses the real existing MIME part limit, with a valid 100-file control", async () => {
  const worker = createNodeIncomingProcessor();
  try {
    const run = (files: number) => worker.run({ kind: "gmail", expectedId: "p", chunks: [new TextEncoder().encode(JSON.stringify(resource("p", files)))] }, new AbortController().signal);
    await expect(run(1001)).rejects.toMatchObject({ code: "mime-limit-parts" });
    const valid = await run(100);
    expect(valid.kind).toBe("gmail");
    expect(valid.message.text).toBe("Exact body p");
    expect(valid.message.attachments).toHaveLength(100);
    expect([...valid.message.attachments[0]!.bytes!]).toEqual([0, 255, 128, 13, 10]);
  } finally { await worker.close(); }
});

async function mailbox(kind: "SQL" | "IndexedDB") {
  const unexpected: string[] = [], requests: URL[] = [];
  const messages = new Map([resource("a"), resource("b")].map((m) => [m.id, m]));
  let additions: string[] = [], transient = false, removed = false;
  let historyDeleted: string[] = [];
  let expired=false, refreshed=false;
  const missing=new Set<string>();
  const deletedTerminal="90071992547409930004";
  let held: { entered: ReturnType<typeof gate>; release: ReturnType<typeof gate> } | undefined;
  // Native Request interception precedes construction of the managed fetchGoogle boundary.
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const refuse = (): never => { unexpected.push("Unexpected synthetic Gmail route"); throw new Error(unexpected.at(-1)); };
    if (!(input instanceof Request) || init !== undefined || input.method !== "GET" || input.redirect !== "error" || input.headers.get("authorization") !== "Bearer synthetic") return refuse();
    const url = new URL(input.url);
    if (url.origin !== new URL(api).origin || !url.pathname.startsWith(`${new URL(api).pathname}/`)) return refuse();
    requests.push(url);
    const path = url.pathname.slice(new URL(api).pathname.length);
    if (path === "/profile" && !url.search) return Response.json({ emailAddress: "me@example.test", historyId: refreshed ? terminal : base });
    if (path === "/labels" && !url.search) return Response.json({ labels: [] });
    if (path === "/messages" && url.searchParams.size === 3 && url.searchParams.get("includeSpamTrash") === "true" && url.searchParams.get("maxResults") === "500" && /^after:\d+$/.test(url.searchParams.get("q") ?? "")) return Response.json({ messages: [...messages.keys()].map((id) => ({ id })) });
    if (path === "/history") {
      const start = url.searchParams.get("startHistoryId");
      if (url.searchParams.get("maxResults") !== "500" || url.searchParams.getAll("historyTypes").sort().join(",") !== "labelAdded,labelRemoved,messageAdded,messageDeleted" || url.searchParams.size !== 6 || (start !== base && start !== terminal && start !== deletedTerminal)) return refuse();
      if(expired && start===base){expired=false;refreshed=true;return Response.json({}, {status:404});}
      if(removed)return Response.json({historyId:deletedTerminal,...(start!==deletedTerminal && {history:[{id:deletedTerminal,messagesDeleted:[{message:{id:"p"}}]}]})});
      return Response.json({ historyId: additions.length ? terminal : base, ...(additions.length && start === base ? { history: [{ id: terminal, messagesAdded: additions.map((id) => ({ message: { id } })), messagesDeleted: historyDeleted.map(id=>({message:{id}})) }] } : {}) });
    }
    const id = path.slice("/messages/".length), format = url.searchParams.get("format");
    if (!path.startsWith("/messages/") || (!messages.has(id) && !missing.has(id)) || url.searchParams.size !== 1 || (format !== "raw" && format !== "minimal")) return refuse();
    if(missing.has(id))return Response.json({}, {status:404});
    if (id === "p" && format === "raw") {
      if (held) { held.entered.release(); await held.release.promise; }
      if (transient) return Response.json({}, { status: 503 });
    }
    const m = messages.get(id)!;
    return Response.json(format === "raw" ? m : { id, labelIds: m.labelIds });
  });
  const dir = mkdtempSync(join(tmpdir(), "terno-poison-")), factory = new IDBFactory(), name = crypto.randomUUID();
  const platform = { uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((resolve) => setImmediate(resolve)) };
  const providers: ProviderRegistry = {
    create: (ctx) => createGmailApiProvider(ctx, { tokens: { get: async () => "synthetic", invalidate() {} }, buildRaw: async () => new Uint8Array() }),
    async verifyImap() {}, async connectGmail() { throw new Error("Unused synthetic consent"); },
  };
  const open = async () => new Backend({ dbPath: join(dir, "synthetic.db"), store: kind === "IndexedDB" ? await IdbMailStore.open({ name, factory, platform, instantSearch: false }) : undefined,
    platform, providers, cipher: plaintextCipher, version: "test", autoSync: false, instantSearch: false, iconTransport: null });
  let backend = await open(); await backend.ready;
  const { account } = await backend.store.accounts.create({ kind: "gmail", email: "me@example.test", displayName: "Synthetic", color: "indigo", now: 1 });
  const runs: Promise<void>[] = [];
  const clients: RpcClient[] = [];
  cleanup.push(async () => {
    held?.release.release(); await Promise.allSettled(runs);
    for(const client of clients) client.close();
    try { expect(unexpected).toEqual([]); expect(backend.net.googlePending()).toBe(0); } finally { await backend.stop(); rmSync(dir, { recursive: true, force: true }); }
  });
  const rows = async () => (await backend.store.debug.snapshot()).messages;
  const cursor = async () => (await backend.store.accounts.config<{ cursor?: unknown }>(account.id))?.config.cursor;
  return {
    account, rows, cursor, requests, messages,
    rpc() { const [local,remote]=createMemoryTransportPair(); backend.connect(remote,{clientId:"repair",origin:"renderer"}); const client=new RpcClient(local);clients.push(client);return client; },
    get backend() { return backend; },
    sync() { const run = backend.syncAccount(account.id); runs.push(run); return run; },
    add(files: number, failRead = false) { transient = failRead; messages.set("p", resource("p", files)); messages.set("c", resource("c")); additions = ["a", "p", "c"]; },
    expireAndDeleteRequested(id: string) { expired=true;missing.add(id); },
    deleteAtCapacity() { historyDeleted=["old0"]; },
    deletePoison() { removed=true; messages.delete("p"); },
    hold() { held = { entered: gate(), release: gate() }; return held; },
    async reopen() { await backend.stop(); backend = await open(); await backend.ready; },
    async cache() {
      const snapshot = await rows();
      return Promise.all(snapshot.map(async (row) => {
        const detail = await backend.store.threads.get(row.threadId);
        const attachments = await backend.store.attachments.current(account.id, { id: row.id });
        const bytes = await Promise.all(attachments.map((a) => backend.store.attachments.read(account.id, a.assetId!, 0)));
        return { row, message: detail!.messages.find((m) => m.id === row.id), attachments, bytes };
      }));
    },
  };
}

describe.each(["SQL", "IndexedDB"] as const)("%s durable malformed-message recovery", (kind) => {
  it("persists good neighbors and advances history past a deterministic refused item", async () => {
    const t = await mailbox(kind); await t.sync(); const cached = await t.cache();
    expect(cached).toHaveLength(2); expect(cached[0]!.bytes).toEqual(["AP+ADQo="]);
    t.add(1001); await t.sync();
    expect((await t.cache()).filter((m) => m.row.providerMsgId !== "c")).toEqual(cached);
    expect.soft((await t.rows()).map((m) => m.providerMsgId).sort()).toEqual(["a", "b", "c"]);
    expect.soft(await t.cursor()).toEqual({ historyId: terminal });
    await t.reopen();
    expect.soft((await t.rows()).map((m) => m.providerMsgId).sort()).toEqual(["a", "b", "c"]);
    expect.soft(await t.cursor()).toEqual({ historyId: terminal });
    const page=await t.rpc().call("captureRepairs.list",{accountId:t.account.id});
    expect(page.items).toMatchObject([{locator:{kind:"gmail",providerId:"p"},state:"blocked",reason:"mime-parts"}]);
    expect((await t.backend.store.accounts.get(t.account.id))!.syncState.status).toBe("idle");
    const reads=t.requests.filter(u=>u.pathname.endsWith("/messages/p") && u.searchParams.get("format")==="raw").length;
    await t.sync();expect(t.requests.filter(u=>u.pathname.endsWith("/messages/p") && u.searchParams.get("format")==="raw")).toHaveLength(reads);
    await t.rpc().call("captureRepairs.retry",{accountId:t.account.id,key:page.items[0]!.key,revision:0});
    expect((await t.backend.store.accounts.get(t.account.id))!.syncState.lastError).toBeNull();
    expect((await t.rpc().call("captureRepairs.list",{accountId:t.account.id})).items).toMatchObject([{state:"blocked",revision:1}]);
    t.add(1,true);
    await t.rpc().call("captureRepairs.retry",{accountId:t.account.id,key:page.items[0]!.key,revision:1});
    expect((await t.rpc().call("captureRepairs.list",{accountId:t.account.id})).items).toMatchObject([{state:"pending",revision:2}]);
    t.add(1);await t.sync();
    expect((await t.rpc().call("captureRepairs.list",{accountId:t.account.id})).items).toEqual([]);
    expect((await t.rows()).map(m=>m.providerMsgId).sort()).toEqual(["a","b","c","p"]);
  });

  it.each(["before publication","after publication"] as const)("retains history at uncertain %s and replays durable ownership after reopen",async(mode)=>{
    const t=await mailbox(kind);await t.sync();const cached=await t.cache();t.add(1001);
    const real=t.backend.store.captureRepairs;
    const getter=vi.spyOn(t.backend.store,"captureRepairs","get").mockReturnValue({...real,block:async(...args)=>{
      if(mode==="before publication")throw new Error("Synthetic publication refusal");
      await real.block(...args);throw new Error("Synthetic lost publication acknowledgement");
    }});
    await t.sync();expect(await t.cursor()).toEqual({historyId:base});
    expect((await t.cache()).filter(m=>["a","b"].includes(m.row.providerMsgId!))).toEqual(cached);
    expect((await real.list(t.account.id)).items).toHaveLength(mode==="before publication"?0:1);
    getter.mockRestore();await t.reopen();await t.sync();
    expect(await t.cursor()).toEqual({historyId:terminal});expect((await t.rpc().call("captureRepairs.list",{accountId:t.account.id})).items).toMatchObject([{state:"blocked"}]);
    expect((await t.rows()).map(m=>m.providerMsgId).sort()).toEqual(["a","b","c"]);
  });

  it("retires rowless repair only on authoritative history deletion and preserves cached siblings",async()=>{
    const t=await mailbox(kind);await t.sync();t.add(1001);await t.sync();const cached=await t.cache();
    expect((await t.rpc().call("captureRepairs.list",{accountId:t.account.id})).items).toHaveLength(1);
    t.deletePoison();await t.sync();expect(await t.cursor()).toEqual({historyId:"90071992547409930004"});
    expect((await t.rpc().call("captureRepairs.list",{accountId:t.account.id})).items).toEqual([]);expect(await t.cache()).toEqual(cached);
    await t.reopen();expect((await t.rpc().call("captureRepairs.list",{accountId:t.account.id})).items).toEqual([]);expect(await t.cache()).toEqual(cached);
  });

  it("R1 retires authoritative deletion before admitting replacement poison at capacity",async()=>{
    const t=await mailbox(kind);await t.sync();const cached=await t.cache();
    for(let i=0;i<1000;i++)await t.backend.store.captureRepairs.block(t.account.id,{kind:"gmail",providerId:`old${i}`},"mime-parts",0);
    t.add(1001);t.deleteAtCapacity();await t.sync();
    expect.soft(await t.cursor()).toEqual({historyId:terminal});
    expect.soft(await t.backend.store.captureRepairs.get(t.account.id,{kind:"gmail",providerId:"old0"})).toBeNull();
    expect.soft(await t.backend.store.captureRepairs.get(t.account.id,{kind:"gmail",providerId:"p"})).toMatchObject({state:"blocked",reason:"mime-parts"});
    expect((await t.cache()).filter(m=>["a","b"].includes(m.row.providerMsgId!))).toEqual(cached);
    await t.reopen();expect.soft(await t.cursor()).toEqual({historyId:terminal});
    expect.soft(await t.backend.store.captureRepairs.get(t.account.id,{kind:"gmail",providerId:"p"})).toMatchObject({state:"blocked"});
  });

  it("R3 exact explicit source404 releases full repair capacity before expired-history reconciliation",async()=>{
    const t=await mailbox(kind);await t.sync();const cached=await t.cache();
    for(let i=0;i<1000;i++)await t.backend.store.captureRepairs.block(t.account.id,{kind:"gmail",providerId:`old${i}`},"mime-parts",0);
    const requested=(await t.backend.store.captureRepairs.get(t.account.id,{kind:"gmail",providerId:"old999"}))!;
    t.add(1001);t.expireAndDeleteRequested("old999");await t.sync();
    expect(await t.cursor()).toMatchObject({historyId:base});
    for(let i=0;i<51;i++){const r=(await t.backend.store.captureRepairs.get(t.account.id,{kind:"gmail",providerId:`old${i}`}))!;await t.backend.store.captureRepairs.retry(t.account.id,r.key,r.revision);}
    await t.rpc().call("captureRepairs.retry",{accountId:t.account.id,key:requested.key,revision:0});
    expect.soft(t.requests.filter(u=>u.pathname.endsWith("/messages/old999")&&u.searchParams.get("format")==="raw")).toHaveLength(1);
    expect.soft(await t.backend.store.captureRepairs.get(t.account.id,{kind:"gmail",providerId:"old999"})).toBeNull();
    expect.soft(await t.backend.store.captureRepairs.get(t.account.id,{kind:"gmail",providerId:"p"})).toMatchObject({state:"blocked",reason:"mime-parts"});
    expect.soft(await t.cursor()).toEqual({historyId:terminal});
    expect(await t.backend.store.captureRepairs.get(t.account.id,{kind:"gmail",providerId:"old0"})).toMatchObject({state:"pending",revision:1});
    expect((await t.cache()).filter(m=>["a","b"].includes(m.row.providerMsgId!))).toEqual(cached);
    await t.reopen();expect.soft(await t.cursor()).toEqual({historyId:terminal});
    expect.soft(await t.backend.store.captureRepairs.get(t.account.id,{kind:"gmail",providerId:"old999"})).toBeNull();
    expect.soft(await t.backend.store.captureRepairs.get(t.account.id,{kind:"gmail",providerId:"old998"})).toMatchObject({state:"blocked",revision:0});
  });

  it("accepts the valid 100-file neighbor and persists exact capture across graceful reopen", async () => {
    const t = await mailbox(kind); await t.sync(); t.add(100); await t.sync();
    expect(await t.cursor()).toEqual({ historyId: terminal });
    const cached = await t.cache(), p = cached.find((m) => m.row.providerMsgId === "p")!;
    expect(p.message).toMatchObject({ bodyText: "Exact body p", attachmentState: "complete" });
    expect(p.attachments).toHaveLength(100); expect(p.bytes).toEqual(Array(100).fill("AP+ADQo="));
    expect((await t.rows()).map((m) => m.providerMsgId).sort()).toEqual(["a", "b", "c", "p"]);
    await t.reopen(); expect(await t.cache()).toEqual(cached); expect(await t.cursor()).toEqual({ historyId: terminal });
  });

  it("retains checkpoint and exact cached data for transient read failure, then replays normally", async () => {
    const t = await mailbox(kind); await t.sync(); const cached = await t.cache(); t.add(1, true); await t.sync();
    expect(await t.cursor()).toEqual({ historyId: base }); expect(await t.cache()).toEqual(cached);
    await t.reopen(); expect(await t.cursor()).toEqual({ historyId: base }); expect(await t.cache()).toEqual(cached);
    t.add(1); await t.sync(); expect(await t.cursor()).toEqual({ historyId: terminal });
    expect((await t.rows()).map((m) => m.providerMsgId).sort()).toEqual(["a", "b", "c", "p"]);
    expect(await t.backend.store.providerStore(t.account.id).pendingAttachmentBodies(50)).toEqual([]);
  });

  it("retains an existing legacy pending capture and its cached body across refusal and reopen", async () => {
    const t = await mailbox(kind); await t.sync(); const cached = await t.cache();
    await t.backend.ingestSliced([{ accountId: t.account.id, providerMsgId: "p", providerThreadId: "shared", rfcMessageId: "p@example.test", inReplyTo: null, references: [], from: { name: "", email: "sender@example.test" }, to: [], cc: [], bcc: [], subject: "Shared", date: 1, snippet: "Legacy", bodyText: "Previously cached exact body", bodyHtml: "<p>Previously cached exact HTML</p>", bodyState: "full", listId: null, isRead: false, isStarred: false, inInbox: true, isSent: false, isDraft: false, isTrash: false, isSpam: false, hasAttachments: true, gmailLabels:["INBOX","UNREAD"], size: 5 }]);
    const p = (await t.rows()).find((m) => m.providerMsgId === "p")!;
    const pending = async () => t.backend.store.providerStore(t.account.id).pendingAttachmentBodies(50);
    expect(await pending()).toEqual([{ id: p.id, providerMsgId: "p" }]);
    const before = await t.cache(); t.messages.set("p", resource("p", 1001)); await t.sync();
    expect(await t.cache()).toEqual(before); expect(await pending()).toEqual([]);
    expect(await t.cursor()).toEqual({ historyId: base });
    await t.reopen(); expect(await t.cache()).toEqual(before); expect(await pending()).toEqual([]);
    t.messages.set("p", resource("p"));
    await t.backend.store.attachments.retry(t.account.id,p.id); await t.sync();
    expect(await pending()).toEqual([]);
    const after = await t.cache(); expect(after.filter((m) => m.row.id !== p.id)).toEqual(cached);
    expect(after.find((m) => m.row.id === p.id)?.message).toMatchObject({ bodyText: "Exact body p", attachmentState: "complete" });
  });

  it("refuses late malformed completion after credential retirement without consuming replay ownership", async () => {
    const t = await mailbox(kind); await t.sync(); const cached = await t.cache(); t.add(1001);
    const held = t.hold(), old = t.sync(); await held.entered.promise;
    await t.backend.dropAccount(t.account.id); await t.backend.signedIn(t.account.id);
    held.release.release(); await old;
    expect(await t.cursor()).toEqual({ historyId: base }); expect(await t.cache()).toEqual(cached);
    await t.reopen(); expect(await t.cursor()).toEqual({ historyId: base }); expect(await t.cache()).toEqual(cached);
    t.add(1); await t.sync(); expect(await t.cursor()).toEqual({ historyId: terminal });
    expect((await t.rows()).map((m) => m.providerMsgId).sort()).toEqual(["a", "b", "c", "p"]);
  });
});
