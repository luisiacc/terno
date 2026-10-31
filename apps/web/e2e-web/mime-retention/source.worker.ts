/// <reference lib="webworker" />
import init from "@sqlite.org/sqlite-wasm";
import { BackendCore, plaintextCipher } from "../../../../packages/backend/src/core";
import { createGmailApiProvider, type ProviderRegistry } from "@terno/mail/portable";
import { RpcClient, createMemoryTransportPair } from "@terno/core/rpc";
import { IdbMailStore, databaseName } from "@terno/idb";
import { OpfsSqliteAdapter } from "../../src/web/worker/stores";
import { webPlatform } from "../../src/web/worker/platform";
import { createBrowserIncomingProcessor } from "../../src/web/worker/incoming-runtime";

self.onmessage = (event: MessageEvent<{ kind: "opfs" | "idb"; taskProbe?: boolean }>) => {
  void (async () => {
    const kind = event.data.kind, name = `source-${crypto.randomUUID()}`, platform = webPlatform(undefined);
    let preparations = 0, workerRuns = 0;
    const prepare = platform.bodyPreparation!; platform.bodyPreparation = (message, failure) => { preparations++; return prepare(message, failure); };
    const sqlite = await init(), adapter = new OpfsSqliteAdapter(sqlite);
    const store = kind === "idb" ? await IdbMailStore.open({ name, factory: indexedDB, platform, instantSearch: false }) : await adapter.open({ name, platform, instantSearch: false });
    const text = `${"alpha e\u0301 😀\r\n".repeat(90000)} boundaryneedle acrossboundary `;
    const html = `<p>${"Exact &amp; complete. ".repeat(90000)}</p>`, inline = Array(12).fill("synthetic ".repeat(350)).join("\r\n");
    const mime = ["From: sender@example.test", "Subject: Synthetic complete", "MIME-Version: 1.0", "Content-Type: multipart/mixed; boundary=m", "", "--m", "Content-Type: multipart/alternative; boundary=a", "", "--a", "Content-Type: text/plain; charset=utf-8", "", text, "--a", "Content-Type: text/html; charset=utf-8", "", html, "--a--", "--m", "Content-Type: application/octet-stream", "Content-Disposition: attachment; filename=witness.bin", "Content-Transfer-Encoding: base64", "", "AP+A", "--m--", ""].join("\r\n");
    const encode = (source: string) => { const bytes = new TextEncoder().encode(source); let binary = ""; for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768)); return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
    // Synthetic server-held wire, not application preparation or an index cache.
    const wires = new Map([["large", JSON.stringify({ id: "large", threadId: "large-thread", labelIds: ["INBOX"], raw: encode(mime) })], ["inline", JSON.stringify({ id: "inline", threadId: "inline-thread", labelIds: ["INBOX"], raw: encode(`From: sender@example.test\r\nSubject: Synthetic inline\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${inline}\r\n`) })]]);
    const unexpected: string[] = [], requests: string[] = [];
    const refuse = (): never => { unexpected.push("Unexpected synthetic source route"); throw new Error("Unexpected synthetic source route"); };
    globalThis.fetch = async (input, options) => {
      if (!(input instanceof Request) || options !== undefined || input.method !== "GET" || input.redirect !== "error" || input.headers.get("authorization") !== "Bearer synthetic") return refuse();
      const url = new URL(input.url), root = "/gmail/v1/users/me", path = url.pathname.slice(root.length), keys = [...new Set(url.searchParams.keys())].sort().join(",");
      if (url.origin !== "https://gmail.googleapis.com" || !url.pathname.startsWith(root + "/")) return refuse();
      if (path === "/profile" && !keys) return Response.json({ emailAddress: "synthetic@example.test", historyId: "10" });
      if (path === "/labels" && !keys) return Response.json({ labels: [] });
      if (path === "/messages" && keys === "includeSpamTrash,maxResults,q" && url.searchParams.get("maxResults") === "500" && url.searchParams.get("includeSpamTrash") === "true" && /^after:\d+$/.test(url.searchParams.get("q") ?? "")) return Response.json({ messages: [...wires.keys()].map((id) => ({ id })) });
      if (path === "/history" && keys === "historyTypes,maxResults,startHistoryId" && url.searchParams.size === 6 && url.searchParams.getAll("historyTypes").sort().join(",") === "labelAdded,labelRemoved,messageAdded,messageDeleted" && url.searchParams.get("maxResults") === "500" && ["10", "11"].includes(url.searchParams.get("startHistoryId") ?? "")) return Response.json({ historyId: "10" });
      const id = path.slice("/messages/".length), wire = wires.get(id);
      if (!path.startsWith("/messages/") || !wire || keys !== "format" || url.searchParams.size !== 1) return refuse();
      const format = url.searchParams.get("format");
      requests.push(`${id}:${format}`);
      if (format === "minimal") return Response.json({ id, labelIds: ["INBOX"] });
      if (format !== "raw") return refuse();
      let offset = 0;
      return new Response(new ReadableStream<Uint8Array>({ pull(controller) { if (offset === wire.length) { controller.close(); return; } const end = Math.min(offset + 65536, wire.length); controller.enqueue(new TextEncoder().encode(wire.slice(offset, end))); offset = end; } }, { highWaterMark: 0 }));
    };
    const processor = createBrowserIncomingProcessor(), run = processor.run.bind(processor);
    processor.run = (input, signal) => { workerRuns++; return run(input, signal); };
    const providers: ProviderRegistry = { create: (ctx) => createGmailApiProvider(ctx, { tokens: { get: async () => "synthetic", invalidate() {} }, buildRaw: async () => new Uint8Array() }), async verifyImap() { throw new Error("Unexpected IMAP route"); }, async connectGmail() { throw new Error("Unexpected consent route"); } };
    // Interception above precedes construction; no fallback ever delegates to a provider.
    const backend = new BackendCore({ store, platform, providers, cipher: plaintextCipher, incomingProcessor: processor, version: "test", host: { kind: "web", capabilities: { imap: false, agents: false, backgroundSync: false, network: "browser" } }, autoSync: false, iconTransport: null });
    let client: RpcClient | undefined, outcome: unknown, probe: Worker | undefined, probeUrl: string | undefined;
    try {
      await backend.ready;
      const { account } = await store.accounts.create({ kind: "gmail", email: "synthetic@example.test", displayName: "Synthetic", color: "indigo", now: 1 });
      await store.filters.save({ name: "boundary", enabled: true, source: "manual", rule: { match: "all", conditions: [{ field: "body", op: "contains", value: "boundaryneedle acrossboundary" }], actions: [{ type: "star" }] } }, 1);
      const native = { execMax: 0, stepMax: 0, commitMax: 0, prepareMax: 0, bindMax: 0, calls: 0 };
      const database = sqlite.oo1.DB.prototype, originalExec = database.exec, originalPrepare = database.prepare, statements = sqlite.oo1.Stmt.prototype, originalStep = statements.step;
      database.exec = function (...args) { const start = performance.now(); try { return originalExec.apply(this, args); } finally { const ms = performance.now() - start; native.execMax = Math.max(native.execMax, ms); if (args[0] === "COMMIT") native.commitMax = Math.max(native.commitMax, ms); native.calls++; } };
      database.prepare = function (...args) { const start = performance.now(); try { return originalPrepare.apply(this, args); } finally { native.prepareMax = Math.max(native.prepareMax, performance.now() - start); } };
      statements.step = function (...args) { const start = performance.now(); try { return originalStep.apply(this, args); } finally { native.stepMax = Math.max(native.stepMax, performance.now() - start); } };
      const originalBind = statements.bind;
      statements.bind = function (...args) { const start = performance.now(); try { return originalBind.apply(this, args); } finally { native.bindMax = Math.max(native.bindMax, performance.now() - start); } };
      let taskLatency = 0, controlLatency = 0, probeMessages = 0, control = false, probeStopped: (() => void) | undefined;
      if (event.data.taskProbe) {
        probeUrl = URL.createObjectURL(new Blob(["let t=setInterval(()=>postMessage(performance.timeOrigin+performance.now()),1);onmessage=()=>{clearInterval(t);postMessage('stopped');close()};"], { type: "text/javascript" }));
        probe = new Worker(probeUrl);
        probe.onmessage = (event) => { if (event.data === "stopped") { probeStopped?.(); return; } probeMessages++; const latency = performance.timeOrigin + performance.now() - Number(event.data); if (control) controlLatency = Math.max(controlLatency, latency); else taskLatency = Math.max(taskLatency, latency); };
      }
      let stall = 0, last = performance.now();
      const heartbeat = setInterval(() => { const now = performance.now(); stall = Math.max(stall, now - last); last = now; }, 1), start = performance.now();
      try { await backend.syncAccount(account.id); } finally { clearInterval(heartbeat); }
      const ingestWall = performance.now() - start;
      if (probe) {
        // Measurement negative control, after the application window: never a product RED or a warmup.
        control = true; const until = performance.now() + 30; while (performance.now() < until) { /* finite control */ }
        await new Promise<void>((resolve) => { probeStopped = resolve; probe!.postMessage("stop"); });
        probe.terminate(); URL.revokeObjectURL(probeUrl!);
      }
      const found = await store.threads.searchText({ query: '"boundaryneedle acrossboundary"', now: 1, limit: 10 });
      if (found.items.length !== 1) throw new Error("Exact captured search failed");
      let largestString = 0, largestBacking = 0;
      const inspect = (value: unknown): void => { if (typeof value === "string") largestString = Math.max(largestString, value.length); else if (ArrayBuffer.isView(value)) largestBacking = Math.max(largestBacking, value.buffer.byteLength); else if (value && typeof value === "object") for (const child of Object.values(value)) inspect(child); };
      const originalGet = IDBObjectStore.prototype.get;
      IDBObjectStore.prototype.get = function (...args) { const request = originalGet.apply(this, args); request.addEventListener("success", () => inspect(request.result)); return request; };
      const statement = sqlite.oo1.Stmt.prototype, originalColumn = statement.get;
      statement.get = function (...args) { const row = originalColumn.apply(this, args); inspect(row); return row; };
      const clone = structuredClone; globalThis.structuredClone = (value, options) => { inspect(value); return clone(value, options); };
      const [local, remote] = createMemoryTransportPair(); backend.connect(remote, { clientId: "exact-source", origin: "renderer" }); client = new RpcClient(local);
      const readStart = performance.now(), detail = await client.call("threads.get", { threadId: found.items[0]!.id }), readWall = performance.now() - readStart, message = detail.messages[0]!;
      const inlineFound = await store.threads.searchText({ query: 'subject:"Synthetic inline"', now: 1, limit: 10 });
      const inlineMessage = (await client.call("threads.get", { threadId: inlineFound.items[0]!.id })).messages[0]!;
      const assetExact = await store.attachments.read(account.id, message.attachments[0]!.assetId!, 0) === "AP+A";
      outcome = { ok: true, kind, native, taskLatency, controlLatency, probeMessages, exact: message.bodyText === text.replace(/\r\n/g, "\n") && message.bodyHtml === html, inlineExact: inlineMessage.bodyText === `${inline.replaceAll("\r\n", "\n")}\n`, assetExact, starred: message.isStarred, workerRuns, preparations, raw: requests.filter((request) => request.endsWith(":raw")).length, minimal: requests.filter((request) => request.endsWith(":minimal")).length, unexpected: unexpected.length, largestString, largestBacking, ingestWall, observedHostStall: stall, readWall, sourceWireBytes: [...wires.values()].reduce((sum, wire) => sum + wire.length, 0) };
    } finally {
      probe?.terminate(); if (probeUrl) URL.revokeObjectURL(probeUrl);
      client?.close(); await backend.stop(); await adapter.release();
      if (kind === "opfs") { const pool = await adapter.install(); await pool.unpauseVfs(); pool.unlink(`/${name}.db`); pool.pauseVfs(); }
      else await new Promise<void>((resolve, reject) => { const request = indexedDB.deleteDatabase(databaseName(name)); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); });
    }
    self.postMessage(outcome);
  })().catch((error) => self.postMessage({ ok: false, message: String(error), stack: error.stack }));
};
