import { once, type EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { RpcClient } from "@terno/core/rpc";
import { webSocketTransport } from "@terno/backend";
import { expect, it, vi } from "vitest";
import WebSocket from "ws";

const observed = vi.hoisted(() => ({ servers: [] as import("node:http").Server[], sockets: [] as import("ws").WebSocketServer[] }));
vi.mock("ws", async (original) => {
  const ws = await original<typeof import("ws")>();
  return { ...ws, WebSocketServer: class extends ws.WebSocketServer {
    constructor(options: import("ws").ServerOptions) { super(options); observed.sockets.push(this); }
  } };
});
vi.mock("node:http", async (original) => {
  const http = await original<typeof import("node:http")>();
  return { ...http, createServer: (...args: Parameters<typeof http.createServer>) => {
    const server = Reflect.apply(http.createServer, http, args) as Server;
    observed.servers.push(server);
    return server;
  } };
});
const { startDevServer } = await import("./server");

async function completed(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise.then(() => true), new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), ms); })]);
  } finally { clearTimeout(timer); }
}

async function event(emitter: EventEmitter, name: string): Promise<unknown[]> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error(`missing ${name}`)), 2000);
  try { return await once(emitter, name, { signal: abort.signal }); }
  finally { clearTimeout(timer); }
}

const header = "GET /?token=shutdown-fixture HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n";

async function withHost(body: (fixture: {
  host: Awaited<ReturnType<typeof startDevServer>>; server: Server; wss: import("ws").WebSocketServer;
  own: <T extends Socket | WebSocket>(peer: T) => T; release: (() => void)[];
  failure: { expected?: unknown };
}) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "terno-dev-close-control-"));
  const peers: (Socket | WebSocket)[] = [], release: (() => void)[] = [];
  const failure: { expected?: unknown } = {};
  let host: Awaited<ReturnType<typeof startDevServer>> | undefined, storeClosed = false;
  try {
    const index = observed.servers.length, sockets = observed.sockets.length;
    host = await startDevServer({ port: 0, dataDir: dir, token: "shutdown-fixture", seed: false, autoSync: false, iconTransport: null });
    const close = host.backend.store.close.bind(host.backend.store);
    vi.spyOn(host.backend.store, "close").mockImplementation(async () => { await close(); storeClosed = true; });
    await body({ host, server: observed.servers[index]!, wss: observed.sockets[sockets]!, own: (peer) => { peers.push(peer); return peer; }, release, failure });
  } finally {
    for (const done of release) done();
    for (const peer of peers) { if (peer instanceof WebSocket) peer.terminate(); else peer.destroy(); }
    try {
      if (host) {
        const result = host.close().then(() => ({ error: undefined }), (error: unknown) => ({ error }));
        expect(await completed(result, 5000), "owned host cleanup completed").toBe(true);
        expect((await result).error).toBe(failure.expected);
      }
    } finally {
      vi.restoreAllMocks();
      if (storeClosed) rmSync(dir, { recursive: true, force: true });
      console.info("DEV_CLOSE_CONTROL_CLEANUP", JSON.stringify({ dir, storeClosed, removed: !existsSync(dir) }));
    }
  }
}

it.each(["no partial peer", "partial peer", "peer destroyed before close"] as const)("real development host closes with %s", async (scenario) => {
  const dir = mkdtempSync(join(tmpdir(), "terno-dev-close-"));
  const stages: string[] = [];
  let raw: Socket | undefined, ws: WebSocket | undefined, closing: Promise<void> | undefined;
  let awaitingAccept: ((socket: Socket) => void) | undefined;
  let backendStopped = false;
  const seen = observed.servers.length;
  let host: Awaited<ReturnType<typeof startDevServer>> | undefined;
  try {
    host = await startDevServer({ port: 0, dataDir: dir, token: "shutdown-fixture", seed: false, autoSync: false, iconTransport: null });
    const server = observed.servers[seen]!;
    const accepted = new Map<number, Socket>();
    const onConnection = (socket: Socket) => {
      const port = socket.remotePort!;
      accepted.set(port, socket); stages.push("accepted");
      socket.once("close", () => accepted.delete(port));
    };
    server.on("connection", onConnection);
    const stop = host.backend.stop.bind(host.backend);
    vi.spyOn(host.backend, "stop").mockImplementation(async () => {
      stages.push("backend-stop-entered"); await stop(); backendStopped = true; stages.push("backend-stop-finished");
    });
    try {
      ws = new WebSocket(`${host.url}?token=shutdown-fixture`);
      await event(ws, "open");
      const client = new RpcClient(webSocketTransport(ws));
      const bootstrap = client.call("app.bootstrap", {});
      expect(await completed(bootstrap, 2000)).toBe(true);
      expect(await bootstrap).toHaveProperty("accounts");
      const clientClosed = event(ws, "close");
      stages.push("bootstrap-finished");
      if (scenario !== "no partial peer") {
        const port = Number(new URL(host.url).port);
        raw = connect(port, "127.0.0.1");
        await event(raw, "connect");
        const peerPort = raw.localPort!;
        let socket = accepted.get(peerPort);
        if (!socket) {
          const arrival = new Promise<Socket>((resolve) => {
            awaitingAccept = (peer) => {
              if (peer.remotePort !== peerPort) return;
              server.removeListener("connection", awaitingAccept!); awaitingAccept = undefined; resolve(peer);
            };
            server.on("connection", awaitingAccept);
          });
          expect(await completed(arrival, 2000), "the matching accepted peer arrived").toBe(true);
          socket = await arrival;
        }
        expect(socket, "the real HTTP server accepted this peer").toBeDefined();
        const received = event(socket, "data");
        raw.write("GET /?token=shutdown-fixture HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n");
        await received; stages.push("partial-header-received");
        if (scenario === "peer destroyed before close") {
          const aborted: string[] = [];
          socket.once("error", (error: NodeJS.ErrnoException) => { aborted.push(error.code ?? "unknown"); });
          const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
          raw.destroy(); expect(await completed(closed, 2000)).toBe(true); await closed; stages.push("peer-closed-before-stop");
          for (const code of aborted) expect(["HPE_INVALID_EOF_STATE", "ECONNRESET"]).toContain(code);
        }
      }
      stages.push("close-requested"); closing = host.close();
      expect(await completed(closing, 5000), JSON.stringify({ scenario, stages })).toBe(true);
      expect(backendStopped).toBe(true);
      expect(await completed(clientClosed, 1000), "the owned WebSocket peer receives close").toBe(true);
      expect(ws.readyState).toBe(WebSocket.CLOSED);
      expect(accepted.size).toBe(0);
    } finally {
      raw?.destroy(); ws?.terminate();
      closing ??= host.close();
      let cleaned = false;
      try { cleaned = await completed(closing, 5000); }
      finally {
        server.removeListener("connection", onConnection); vi.restoreAllMocks();
        if (awaitingAccept) server.removeListener("connection", awaitingAccept);
        if (cleaned) rmSync(dir, { recursive: true, force: true });
        console.info("DEV_CLOSE_CLEANUP", JSON.stringify({ scenario, dir, removed: !existsSync(dir), stages, node: process.versions.node, pid: process.pid }));
      }
      expect(cleaned, `owned backend must close before removing ${dir}`).toBe(true);
    }
  } finally {
    if (!host) console.info("DEV_CLOSE_SETUP_FAILED", JSON.stringify({ dir }));
  }
}, 20_000);

it.each(["late headers", "close inside headers"])("rejects upgrade admission during %s", async (scenario) => {
  await withHost(async ({ host, server, wss, own }) => {
    const admitted = vi.spyOn(host.backend, "connect");
    const accepted = event(server, "connection");
    const raw = own(connect(Number(new URL(host.url).port), "127.0.0.1"));
    raw.on("error", () => {});
    await event(raw, "connect");
    const socket = (await accepted)[0] as Socket;
    socket.on("error", () => {});
    const received = event(socket, "data");
    raw.write(header); await received;
    let closing: Promise<void> | undefined;
    if (scenario === "late headers") {
      closing = host.close();
      raw.write("\r\n");
    } else {
      const headers = event(wss, "headers");
      wss.once("headers", () => { closing = host.close(); });
      raw.write("\r\n"); await headers;
    }
    expect(closing).toBeDefined();
    expect(await completed(closing!, 2000)).toBe(true);
    expect(admitted).not.toHaveBeenCalled();
    expect(wss.clients.size).toBe(0);
    expect(socket.destroyed).toBe(true);
  });
}, 10_000);

it.each([
  ["wrong", undefined],
  ["shutdown-fixture", "https://foreign.invalid"],
] as const)("keeps upgrade authentication for token %s and origin %s", async (token, origin) => {
  await withHost(async ({ host, own }) => {
    const admitted = vi.spyOn(host.backend, "connect");
    const ws = own(new WebSocket(`${host.url}?token=${token}`, origin ? { origin } : undefined));
    ws.on("error", () => {});
    const response = await event(ws, "unexpected-response");
    const http = response[1] as import("node:http").IncomingMessage;
    expect(http.statusCode).toBe(401); http.resume();
    expect(admitted).not.toHaveBeenCalled();
  });
}, 10_000);

it("joins a reentrant close before cleanup reaches the backend", async () => {
  await withHost(async ({ host, server, release }) => {
    let reached!: () => void, unblock!: () => void, nested: Promise<void> | undefined;
    const entered = new Promise<void>((resolve) => { reached = resolve; });
    const gate = new Promise<void>((resolve) => { unblock = resolve; }); release.push(unblock);
    const realStoreClose = vi.mocked(host.backend.store.close).getMockImplementation()!;
    const storeClose = vi.spyOn(host.backend.store, "close").mockImplementation(async () => { reached(); await gate; await realStoreClose(); });
    const closeConnections = server.closeAllConnections.bind(server);
    vi.spyOn(server, "closeAllConnections").mockImplementation(() => { nested = host.close(); closeConnections(); });
    const first = host.close();
    expect(await completed(entered, 2000)).toBe(true);
    expect(nested).toBe(first);
    expect(await completed(nested!, 20)).toBe(false);
    unblock(); await first; await host.close();
    expect(storeClose).toHaveBeenCalledTimes(1);
  });
}, 10_000);

it.each([false, true])("preserves cleanup errors while closing the store (multiple=%s)", async (multiple) => {
  await withHost(async ({ host, server, failure }) => {
    const transportError = new Error("owned transport failure"), backendError = new Error("owned backend failure");
    const closeConnections = server.closeAllConnections.bind(server);
    vi.spyOn(server, "closeAllConnections").mockImplementation(() => { closeConnections(); throw transportError; });
    if (multiple) {
      const stop = host.backend.stop.bind(host.backend);
      vi.spyOn(host.backend, "stop").mockImplementation(async () => { await stop(); throw backendError; });
    }
    const closing = host.close();
    const error = await closing.then(() => undefined, (reason: unknown) => reason);
    if (multiple) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([transportError, backendError]);
    } else expect(error).toBe(transportError);
    failure.expected = error;
    expect(host.close()).toBe(closing);
    await expect(host.close()).rejects.toBe(error);
  });
}, 10_000);

it("concurrent host closes join the first backend cleanup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "terno-dev-close-join-"));
  const host = await startDevServer({ port: 0, dataDir: dir, token: "shutdown-join", seed: false, autoSync: false, iconTransport: null });
  let reached!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => { reached = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const realStoreClose = host.backend.store.close.bind(host.backend.store);
  let calls = 0, firstDone = false, secondDone = false, storeClosed = false;
  const storeClose = vi.spyOn(host.backend.store, "close").mockImplementation(async () => { calls++; reached(); await gate; await realStoreClose(); storeClosed = true; });
  const first = host.close(); first.then(() => { firstDone = true; }, () => { firstDone = true; });
  let second: Promise<void> | undefined;
  try {
    expect(await completed(entered, 5000), "the real first stop reached store cleanup").toBe(true);
    second = host.close(); second.then(() => { secondDone = true; }, () => { secondDone = true; });
    await nextTurn(); await nextTurn();
    expect(firstDone).toBe(false);
    expect(secondDone, "a second host close must join the still-held first cleanup").toBe(false);
    release(); await Promise.all([first, second]);
    await host.close();
    expect(calls).toBe(1);
  } finally {
    release();
    const results = await Promise.allSettled([first, ...(second ? [second] : [])]);
    storeClose.mockRestore();
    const errors = results.filter((result) => result.status === "rejected");
    if (storeClosed) rmSync(dir, { recursive: true, force: true });
    console.info("DEV_CLOSE_JOIN_CLEANUP", JSON.stringify({ dir, removed: !existsSync(dir), calls, storeClosed }));
    expect(errors).toEqual([]);
  }
}, 20_000);
