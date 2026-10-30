import "fake-indexeddb/auto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { IdbMailStore } from "@terno/idb";
import { createGmailApiProvider, type ProviderContext, type ProviderRegistry } from "@terno/mail/portable";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Backend, plaintextCipher } from "./backend";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((r) => { release = r; });
  return { promise, release };
};

async function fixture(kind: "SQL" | "IndexedDB", path?: string) {
  const dir = path ?? mkdtempSync(join(tmpdir(), "terno-sync-owner-"));
  const factory = new IDBFactory(), name = crypto.randomUUID();
  const routes: string[] = [];
  const historyReplies: { start: string; ids: string[] }[] = [];
  const contexts: ProviderContext[] = [];
  let h2 = false, identity = "me@example.test";
  let historyGate: (() => Promise<void>) | undefined;
  let cursorGate: ((value: unknown) => Promise<void>) | undefined;
  const raw = Buffer.from(['From: Sender <sender@example.test>', 'To: me@example.test', 'Subject: arrival', 'Message-ID: <arrival@example.test>',
    'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="b"', '', '--b', 'Content-Type: text/plain', '', 'Exact body',
    '--b', 'Content-Type: application/octet-stream', 'Content-Disposition: attachment; filename="exact.bin"', 'Content-Transfer-Encoding: base64', '', 'AP+ADQo=', '--b--', ''].join('\r\n')).toString('base64url');
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    routes.push(`${request.method} ${url.pathname}${url.search}`);
    expect(request.headers.get("authorization")).toBe("Bearer synthetic");
    if (url.origin !== "https://gmail.googleapis.com" || request.method !== "GET") throw new Error(`Unexpected synthetic route ${request.url}`);
    const endpoint = url.pathname.replace("/gmail/v1/users/me", "");
    if (endpoint === "/profile") return Response.json({ emailAddress: identity, historyId: h2 ? "102" : "100" });
    if (endpoint === "/labels") return Response.json({ labels: [] });
    if (endpoint === "/history") {
      const value = h2 ? { historyId: "102", history: [{ id: "101", messagesAdded: [{ message: { id: "arrival" } }] }, { id: "102", labelsRemoved: [{ message: { id: "arrival" } }] }] } : { historyId: "100", history: [] };
      const start = url.searchParams.get("startHistoryId");
      if (start !== "100" && start !== "102") throw new Error(`Unexpected history cursor ${start}`);
      value.history = value.history.filter((h) => BigInt(h.id) > BigInt(start));
      historyReplies.push({ start: url.searchParams.get("startHistoryId")!, ids: value.history.map((h) => h.id) });
      const hold = historyGate; historyGate = undefined; await hold?.();
      return Response.json(value);
    }
    if (endpoint === "/messages/arrival") return Response.json(url.searchParams.get("format") === "raw"
      ? { id: "arrival", threadId: "arrival", labelIds: ["STARRED"], raw }
      : { id: "arrival", labelIds: ["STARRED"] });
    throw new Error(`Unexpected synthetic route ${request.url}`);
  });
  const providers: ProviderRegistry = {
    create(ctx) {
      contexts.push(ctx);
      return createGmailApiProvider({ ...ctx, saveCursor: async (value, check) => { await ctx.saveCursor(value, check); await cursorGate?.(value); } }, {
        tokens: { get: async () => "synthetic", invalidate() {} }, buildRaw: async () => new Uint8Array(),
      });
    }, async verifyImap() {}, async connectGmail() { throw new Error("Unused consent"); },
  };
  const open = async (autoSync: boolean) => {
    const b = new Backend({ dbPath: join(dir, "mail.db"), store: kind === "IndexedDB" ? await IdbMailStore.open({ name, factory, instantSearch: false,
      platform: { uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((r) => setImmediate(r)) } }) : undefined,
      providers, cipher: plaintextCipher, version: "test", autoSync, instantSearch: false, iconTransport: null, syncIntervalMs: 3_600_000 });
    await b.ready; return b;
  };
  let backend = await open(false);
  const existing = await backend.store.accounts.list();
  const account = existing[0] ?? (await backend.store.accounts.create({ kind: "gmail", email: "me@example.test", displayName: "Synthetic", color: "indigo", now: 1 })).account;
  if (!existing.length) {
    await backend.store.accounts.setCursor(account.id, { historyId: "100" });
    const category = await backend.store.categories.create("Synthetic", "violet");
    await backend.store.filters.save({ name: "Arrival", enabled: true, source: "manual", rule: { match: "all", conditions: [{ field: "subject", op: "contains", value: "arrival" }], actions: [{ type: "addCategory", categoryId: category.id }] } }, 1);
  }
  const filter = (await backend.store.filters.list())[0]!;
  const category = (await backend.store.categories.list()).find((c) => c.name === "Synthetic")!;
  const cursor = async () => (await backend.store.accounts.config<{ cursor?: unknown }>(account.id))?.config.cursor;
  const rpc = () => {
    const [local, remote] = createMemoryTransportPair(); backend.connect(remote, { clientId: "synthetic", origin: "renderer" });
    const client = new RpcClient(local); cleanup.push(async () => { client.close(); }); return client;
  };
  cleanup.push(async () => { await backend.stop(); if (!path) rmSync(dir, { recursive: true, force: true }); });
  return {
    dir, account, contexts, routes, cursor, rpc,
    historyStarts() { return routes.filter((r) => r.includes("/history?")).map((r) => new URL(r.slice(4), "https://fixture.test").searchParams.get("startHistoryId")); }, identity(value: string) { identity = value; }, get backend() { return backend; }, newer() { h2 = true; },
    holdHistory(fn: () => Promise<void>) { historyGate = fn; }, holdCursor(fn?: (value: unknown) => Promise<void>) { cursorGate = fn; },
    async reopen(autoSync: boolean) {
      await backend.stop(); backend = await open(autoSync); routes.length = 0;
      const sync = vi.spyOn(backend, "syncAccount");
      await backend.start();
      await Promise.all(sync.mock.results.map((r) => r.value));
      sync.mockRestore();
    },
    async exact() {
      expect(await cursor()).toEqual({ historyId: "102" });
      for (const reply of historyReplies) for (const id of reply.ids) expect(BigInt(id)).toBeGreaterThan(BigInt(reply.start));
      const snapshot = await backend.store.debug.snapshot();
      expect(snapshot.messages).toHaveLength(1);
      const message = snapshot.messages[0]!;
      expect(message).toMatchObject({ providerMsgId: "arrival", isRead: true, isStarred: true, inInbox: false, bodyText: expect.stringContaining("Exact body") });
      const assets = await backend.store.attachments.current(account.id, { id: message.id });
      expect(assets).toHaveLength(1);
      expect(await backend.store.attachments.read(account.id, assets[0]!.assetId!, 0)).toBe("AP+ADQo=");
      expect(snapshot.ops).toEqual([]);
      expect(snapshot.memberships.filter((m) => m.categoryId === category.id)).toHaveLength(1);
      expect((await backend.store.filters.get(filter.id))?.hits).toBe(1);
      return { message, assets, filterHits: (await backend.store.filters.get(filter.id))?.hits };
    },
  };
}

describe.each(["SQL", "IndexedDB"] as const)("%s local ownership", (kind) => {
  it("startup refuses a mismatched Google subject before history, then a legitimate owner recovers", async () => {
    const t = await fixture(kind); t.newer(); t.identity("other@example.test");
    await t.reopen(true);
    expect(await t.cursor()).toEqual({ historyId: "100" });
    expect(t.routes.some((r) => r.includes("/history") || r.includes("/messages"))).toBe(false);
    expect((await t.backend.store.debug.snapshot()).messages).toEqual([]);
    t.identity("me@example.test");
    await t.backend.dropAccount(t.account.id); await t.backend.signedIn(t.account.id);
    const sync = vi.spyOn(t.backend, "syncAccount");
    t.backend.startAccount(t.account);
    await Promise.all(sync.mock.results.map((r) => r.value));
    await t.exact();
  });

  it("startup alone replays history lost with a volatile overlapping trigger", async () => {
    const t = await fixture(kind);
    const entered = gate(), release = gate(); cleanup.push(async () => { release.release(); });
    t.holdHistory(async () => { entered.release(); await release.promise; });
    const running = t.backend.syncAccount(t.account.id); await entered.promise;
    t.newer(); await t.rpc().call("sync.now", { accountId: t.account.id });
    await t.backend.dropAccount(t.account.id);
    release.release(); await running;
    expect(await t.cursor()).toEqual({ historyId: "100" });
    await t.reopen(false);
    expect(await t.cursor()).toEqual({ historyId: "100" });
    expect(t.routes).toEqual([]);
    await t.reopen(true);
    await expect.poll(t.cursor).toEqual({ historyId: "102" });
    const first = await t.exact();
    expect(t.historyStarts()).toEqual(["100"]);
    expect(t.routes.some((r) => /\/messages\?/.test(r))).toBe(false);
    await t.reopen(true); await expect.poll(t.cursor).toEqual({ historyId: "102" });
    expect(await t.exact()).toEqual(first);
    expect(t.historyStarts()).toEqual(["102"]);
  });

  it("old final checkpoint and finalizer cannot overwrite a replacement or consume its trailing request", async () => {
    const t = await fixture(kind);
    const committed = gate(), releaseOld = gate(), replacement = gate(), releaseNew = gate();
    cleanup.push(async () => { releaseOld.release(); releaseNew.release(); });
    t.holdCursor(async () => { t.holdCursor(); committed.release(); await releaseOld.promise; });
    const old = t.backend.syncAccount(t.account.id); await committed.promise;
    const stale = t.contexts[0]!;
    await t.backend.dropAccount(t.account.id); await t.backend.signedIn(t.account.id);
    t.newer(); t.holdHistory(async () => { replacement.release(); await releaseNew.promise; });
    const sync = vi.spyOn(t.backend, "syncAccount");
    const fresh = t.backend.syncAccount(t.account.id); await replacement.promise;
    await t.rpc().call("sync.now", { accountId: t.account.id });
    releaseOld.release(); await old;
    await expect(stale.loadCursor()).rejects.toMatchObject({ name: "AbortError" });
    await expect(stale.saveCursor({ historyId: "1" })).rejects.toMatchObject({ name: "AbortError" });
    expect(await t.cursor()).toEqual({ historyId: "100" });
    releaseNew.release(); await fresh;
    await Promise.all(sync.mock.results.map((r) => r.value));
    expect(sync).toHaveBeenCalledTimes(3);
    expect(t.routes.filter((r) => r.includes("/history?"))).toHaveLength(3);
    await t.exact();
  });
});

it.each(["effects", "cursor"] as const)("SQLite abrupt restart at %s boundary", async (boundary) => {
  const childDir = process.env.TERNO_SYNC_CRASH_DIR;
  if (childDir) {
    const t = await fixture("SQL", childDir); t.newer();
    const block = async () => {
      await t.rpc().call("sync.now", { accountId: t.account.id });
      writeFileSync(join(childDir, "ready"), JSON.stringify({ pid: process.pid, cursor: await t.cursor(), snapshot: await t.backend.store.debug.snapshot() }));
      await new Promise<void>(() => {});
    };
    if (boundary === "cursor") t.holdCursor(block);
    else {
      const save = t.backend.store.accounts.setCursor;
      vi.spyOn(t.backend.store.accounts, "setCursor").mockImplementation(async (...args) => { await block(); return save(...args); });
    }
    await t.backend.syncAccount(t.account.id);
    throw new Error("Crash boundary escaped");
  }
  const dir = mkdtempSync(join(tmpdir(), "terno-sync-crash-"));
  const guard = join(dir, "network-guard.cjs");
  writeFileSync(guard, `
const fs = require('node:fs');
const net = require('node:net');
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = args[0];
  const options = typeof first === 'object' && first !== null ? first : typeof first === 'number' ? { port: first, host: typeof args[1] === 'string' ? args[1] : 'localhost' } : { path: first };
  if (!options.path && !['127.0.0.1', '::1', 'localhost'].includes(options.host || 'localhost')) throw new Error('External network blocked by sync test');
  return connect.apply(this, args);
};
globalThis.fetch = () => { throw new Error('External fetch blocked by sync test'); };
fs.writeFileSync(${JSON.stringify(join(dir, "guard-loaded"))}, 'loaded');
`);
  const child = spawn(process.execPath, [resolve("node_modules/vitest/vitest.mjs"), "run", "--project", "unit", "--pool=threads", "--maxWorkers=1", "packages/backend/src/sync-ownership.int.test.ts", "-t", `SQLite abrupt restart at ${boundary} boundary`], {
    env: { ...process.env, TERNO_SYNC_CRASH_DIR: dir, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${JSON.stringify(guard)}` }, stdio: ["ignore", "pipe", "pipe"],
  });
  const pid = child.pid; expect(pid).toBeTypeOf("number");
  let output = ""; child.stdout.on("data", (b: Buffer) => { output += b.toString(); }); child.stderr.on("data", (b: Buffer) => { output += b.toString(); });
  const exited = once(child, "exit");
  cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; rmSync(dir, { recursive: true, force: true }); });
  await expect.poll(() => { if (child.exitCode !== null) throw new Error(output); return existsSync(join(dir, "ready")); }, { timeout: 15_000 }).toBe(true);
  expect(existsSync(join(dir, "guard-loaded"))).toBe(true);
  const ready = JSON.parse(readFileSync(join(dir, "ready"), "utf8")) as { pid: number; cursor: unknown };
  expect(ready.pid).toBe(pid);
  expect(ready.cursor).toEqual({ historyId: boundary === "cursor" ? "102" : "100" });
  child.kill("SIGKILL");
  expect(await exited).toEqual([null, "SIGKILL"]);
  const t = await fixture("SQL", dir); t.newer();
  expect(await t.cursor()).toEqual({ historyId: boundary === "cursor" ? "102" : "100" });
  expect((await t.backend.store.accounts.get(t.account.id))?.syncState.lastSyncAt).toBeNull();
  const before = await t.backend.store.debug.snapshot();
  expect(before.messages).toHaveLength(1);
  const beforeAssets = await t.backend.store.attachments.current(t.account.id, { id: before.messages[0]!.id });
  await t.reopen(true); await expect.poll(t.cursor).toEqual({ historyId: "102" });
  const first = await t.exact();
  expect(t.historyStarts()).toEqual([boundary === "cursor" ? "102" : "100"]);
  expect((await t.backend.store.accounts.get(t.account.id))?.syncState.lastSyncAt).not.toBeNull();
  expect(first.message.id).toBe(before.messages[0]!.id);
  expect(first.assets).toEqual(beforeAssets);
  expect(t.routes.some((r) => /\/messages\?/.test(r))).toBe(false);
  await t.reopen(true); expect(await t.exact()).toEqual(first);
  expect(t.historyStarts()).toEqual(["102"]);
}, 25_000);
