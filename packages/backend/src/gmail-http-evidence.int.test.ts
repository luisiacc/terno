import "fake-indexeddb/auto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as nativeTimeout, clearTimeout as clearNativeTimeout } from "node:timers";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { installDiag } from "@terno/core/diag";
import { IdbMailStore } from "@terno/idb";
import { IDBFactory } from "fake-indexeddb";
import { createGmailProvider, ProviderError, type ProviderRegistry } from "@terno/mail";
import { afterEach, describe, expect, it } from "vitest";
import { Backend, plaintextCipher } from "./backend";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  installDiag({ proc: "backend", version: "test", build: "test", channel: "dev" });
});

describe.each(["SQL", "IndexedDB"] as const)("%s raw provider headers stay out of persisted and RPC outcomes", (kind) => {
  it("preserves header evidence locally while sync and send errors use existing sanitized projections", async () => {
    const marker = "PRIVATE_HTTP_HEADER_synthetic@example.test_SECRET";
    const requests: string[] = [], records: unknown[] = [], logs: unknown[] = [], frames: unknown[] = [];
    const sockets = new Set<Socket>(), abort = new AbortController();
    const watchdog = nativeTimeout(() => abort.abort(new Error("Fixture watchdog")), 5000);
    const server = createServer(async (request, response) => {
      for await (const _chunk of request) { /* Consume only synthetic compose payloads. */ }
      requests.push(request.url!);
      if (request.url === "/token") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ access_token: "synthetic-access", token_type: "Bearer", expires_in: 3600 }));
      } else {
        response.writeHead(429, { "content-type": "application/json", "retry-after": marker, date: marker });
        response.end(JSON.stringify({ error: { message: marker } }));
      }
    });
    server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing synthetic server address");
    const origin = `http://127.0.0.1:${address.port}`, dir = mkdtempSync(join(tmpdir(), "terno-http-evidence-"));
    const factory = new IDBFactory(), name = crypto.randomUUID();
    const platform = { uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((resolve) => setImmediate(resolve)) };
    const registry: ProviderRegistry = {
      create(ctx) { return createGmailProvider({ ...ctx, fetch: (input, init) => ctx.fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, abort.signal]) : abort.signal }) }, { endpoints: { token: `${origin}/token`, api: `${origin}/mail` } }); },
      async verifyImap() {}, async connectGmail() { throw new Error("Unused fixture consent"); },
    };
    const open = async () => new Backend({
      dbPath: join(dir, "synthetic.db"), store: kind === "IndexedDB" ? await IdbMailStore.open({ name, factory, platform, instantSearch: false }) : undefined,
      platform, version: "test", providers: registry, cipher: plaintextCipher, autoSync: false, instantSearch: false, iconTransport: null,
      log: (...args) => logs.push(args),
    });
    let backend = await open();
    let client: RpcClient | undefined;
    const attach = () => {
      const [local, remote] = createMemoryTransportPair();
      local.onMessage((frame) => frames.push(frame));
      backend.connect(remote, { clientId: "synthetic", origin: "renderer" });
      client = new RpcClient(local, { defaultTimeoutMs: 5000 });
      return client;
    };
    cleanup.push(async () => {
      abort.abort(); clearNativeTimeout(watchdog); client?.close();
      try { await backend.stop(); }
      finally {
        const closed = new Promise<void>((resolve) => server.close(() => resolve()));
        await Promise.all([...sockets].map((socket) => new Promise<void>((resolve) => { socket.once("close", resolve); socket.destroy(); })));
        await closed; expect(sockets.size).toBe(0); rmSync(dir, { recursive: true, force: true });
      }
    });
    installDiag({ proc: "backend", version: "test", build: "test", channel: "dev", sink: { write: (entry) => records.push(entry), capture: (record) => records.push(record) } });
    let rpc = attach(); await rpc.call("app.bootstrap", {});
    const { account } = await backend.store.accounts.create({ kind: "gmail", email: "synthetic@example.test", displayName: "Synthetic", color: "indigo", providerConfig: {}, now: 1 });
    await backend.store.settings.set("app", { gmailClientId: "synthetic-client" });
    await backend.setSecret(`account:${account.id}:refreshToken`, "synthetic-refresh");
    const provider = await backend.provider(account.id);
    if (!provider) throw new Error("Missing fixture provider");
    const error: unknown = await provider.verify().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).httpResponse?.retryAfter).toEqual({ kind: "value", value: marker });
    await backend.syncAccount(account.id);
    const { opId } = await rpc.call("compose.send", { accountId: account.id, to: [{ email: "recipient@example.test", name: "" }], subject: "Synthetic", bodyText: "Synthetic body" });
    await backend.runWorker();
    const [op] = await rpc.call("ops.list", {});
    expect(op).toMatchObject({ id: opId, state: "queued", lastError: expect.stringContaining("429") });
    const stored = await backend.store.ops.get(opId), accounts = (await rpc.call("app.bootstrap", {})).accounts;
    expect(accounts.find((entry) => entry.id === account.id)?.syncState.lastError).toContain("429");
    expect(stored).toMatchObject({ state: "queued", attempts: 1 });
    expect(requests).toEqual(["/token", "/mail/profile", "/mail/profile", "/mail/messages/send"]);
    expect(records.length).toBeGreaterThan(0); expect(logs.length).toBeGreaterThan(0); expect(frames.length).toBeGreaterThan(0);
    expect(JSON.stringify([stored, accounts, op, records, logs, frames])).not.toContain(marker);
    expect(JSON.stringify([stored, accounts, op, records, logs, frames])).not.toContain("httpResponse");
    client?.close(); await backend.stop(); backend = await open(); rpc = attach();
    expect((await rpc.call("ops.list", {}))[0]).toMatchObject({ id: opId, state: "queued", lastError: expect.stringContaining("429") });
    expect(await backend.store.ops.get(opId)).toEqual(stored);
    expect(JSON.stringify([await rpc.call("app.bootstrap", {}), records, logs, frames])).not.toContain(marker);
    expect(requests).toHaveLength(4);
  });
});
