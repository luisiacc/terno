import { L } from "@terno/i18n";
import { describe, expect, it, vi } from "vitest";
import { RpcClient } from "./client";
import { RpcError, type Transport } from "./envelope";
import { createMemoryTransportPair } from "./memory";
import { RpcServer, type Handlers } from "./server";

function setup(overrides: Partial<Handlers> = {}) {
  const handlers = {
    "counts.get": () => ({ inboxUnread: 3, inboxUnreadByAccount: { 1: 3 }, categoryUnread: {}, categoryTotal: {}, categorySuggestions: {} }),
    "threads.get": ({ threadId }: { threadId: number }) => {
      throw new RpcError("NOT_FOUND", `thread ${threadId} not found`);
    },
    "threads.list": async (p: { limit: number }) => ({ items: [], nextCursor: null, limitSeen: p.limit }),
    ...overrides,
  } as unknown as Handlers;
  const server = new RpcServer(handlers, { onError: vi.fn() });
  const [clientSide, serverSide] = createMemoryTransportPair();
  server.connect(serverSide, { clientId: "t", origin: "renderer" });
  const client = new RpcClient(clientSide, { defaultTimeoutMs: 200 });
  return { server, client, clientSide, serverSide };
}

describe("rpc", () => {
  it("round-trips a call and applies schema defaults on the server", async () => {
    const { client } = setup();
    expect(await client.call("counts.get", {})).toMatchObject({ inboxUnread: 3 });
    const page = (await client.call("threads.list", { view: "inbox" })) as unknown as { limitSeen: number };
    expect(page.limitSeen).toBe(100);
  });

  it("rejects invalid params with BAD_REQUEST before reaching the handler", async () => {
    const list = vi.fn();
    const { client } = setup({ "threads.list": list as never });
    await expect(client.call("threads.list", { view: "nope" as never })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(list).not.toHaveBeenCalled();
  });

  it("propagates typed handler errors", async () => {
    const { client } = setup();
    await expect(client.call("threads.get", { threadId: 9 })).rejects.toMatchObject({ code: "NOT_FOUND", message: "thread 9 not found" });
  });

  it("carries a catalog message across the wire; the client renders it in its own language", async () => {
    const handlers = {
      "threads.get": () => {
        throw new RpcError("NOT_FOUND", L("language.system", { language: "X" }));
      },
      "counts.get": () => {
        throw Object.assign(new Error("System (Y)"), { expected: true, i18n: L("language.system", { language: "Y" }) });
      },
      "threads.list": () => {
        throw Object.assign(new Error("plain"), { expected: true, i18n: { key: 1 } });
      },
    } as unknown as Handlers;
    const server = new RpcServer(handlers);
    const [clientSide, serverSide] = createMemoryTransportPair();
    server.connect(serverSide, { clientId: "t", origin: "renderer" });
    const english = new RpcClient(clientSide);
    await expect(english.call("threads.get", { threadId: 1 })).rejects.toMatchObject({ message: "System (X)", i18n: { key: "language.system", params: { language: "X" } } });
    const [c2, s2] = createMemoryTransportPair();
    server.connect(s2, { clientId: "u", origin: "renderer" });
    const translated = new RpcClient(c2, { translate: (m) => `${m.key}|${m.params?.language}|${m.message}` });
    await expect(translated.call("threads.get", { threadId: 1 })).rejects.toMatchObject({ message: "language.system|X|System (X)" });
    await expect(translated.call("counts.get", {})).rejects.toMatchObject({ message: "language.system|Y|System (Y)" });
    // a malformed reference is ignored: the message stays as sent
    await expect(translated.call("threads.list", { view: "inbox" })).rejects.toMatchObject({ message: "plain", i18n: undefined });
  });

  it("keeps the expected/unexpected verdict across the wire; only bugs reach onError", async () => {
    const onError = vi.fn();
    const handlers = {
      "threads.get": () => {
        throw new RpcError("NOT_FOUND", "gone");
      },
      "counts.get": () => {
        throw Object.assign(new Error("wrong password"), { expected: true });
      },
      "threads.list": () => {
        throw new TypeError("x is undefined");
      },
    } as unknown as Handlers;
    const server = new RpcServer(handlers, { onError });
    const [clientSide, serverSide] = createMemoryTransportPair();
    server.connect(serverSide, { clientId: "t", origin: "renderer" });
    const client = new RpcClient(clientSide);
    await expect(client.call("threads.get", { threadId: 1 })).rejects.toMatchObject({ code: "NOT_FOUND", expected: true });
    await expect(client.call("counts.get", {})).rejects.toMatchObject({ code: "INTERNAL", expected: true });
    await expect(client.call("threads.list", { view: "inbox" })).rejects.toMatchObject({ code: "INTERNAL", expected: false, diag: "rpc.handler_threw" });
    await expect(client.call("threads.list", { view: "nope" as never })).rejects.toMatchObject({ code: "BAD_REQUEST", expected: false });
    expect(onError.mock.calls.map(([e, m]) => [(e as Error).name, m])).toEqual([
      ["TypeError", "threads.list"],
      ["ZodError", "threads.list"],
    ]);
  });

  it("times out calls that never answer", async () => {
    const { client } = setup({ "threads.list": (() => new Promise(() => {})) as never });
    await expect(client.call("threads.list", { view: "inbox" })).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("fails in-flight calls immediately when the transport closes", async () => {
    const { client, serverSide } = setup({ "threads.list": (() => new Promise(() => {})) as never });
    const pending = client.call("threads.list", { view: "inbox" });
    serverSide.close();
    await expect(pending).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await expect(client.call("counts.get", {})).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("failures made on this side (not connected, closed, restarted, timed out) are catalog messages, in this side's language", async () => {
    const english = new RpcClient();
    await expect(english.call("counts.get", {})).rejects.toMatchObject({ code: "UNAVAILABLE", message: "Terno isn’t connected to the mail engine yet. Try again in a moment.", i18n: { key: "errors.rpc.notConnected" } });

    const translate = (m: { key: string; message: string }) => `es:${m.key}`;
    const neverAnswers = { "threads.list": (() => new Promise(() => {})) as never };
    const server = new RpcServer(neverAnswers as unknown as Handlers);
    const [c1, s1] = createMemoryTransportPair();
    server.connect(s1, { clientId: "t", origin: "renderer" });
    const client = new RpcClient(c1, { translate, defaultTimeoutMs: 5 });
    await expect(client.call("threads.list", { view: "inbox" })).rejects.toMatchObject({ code: "TIMEOUT", message: "es:errors.rpc.timeout", details: { method: "threads.list", timeoutMs: 5 } });

    const replaced = client.call("threads.list", { view: "inbox" });
    const [c2, s2] = createMemoryTransportPair();
    server.connect(s2, { clientId: "t2", origin: "renderer" });
    client.attach(c2);
    await expect(replaced).rejects.toMatchObject({ code: "UNAVAILABLE", message: "es:errors.rpc.restarted" });

    const closed = client.call("threads.list", { view: "inbox" });
    s2.close();
    await expect(closed).rejects.toMatchObject({ message: "es:errors.rpc.closed", i18n: { key: "errors.rpc.closed" } });
    await expect(client.call("counts.get", {})).rejects.toMatchObject({ message: "es:errors.rpc.notConnected" });
  });

  it("can reattach to a new transport after a backend restart", async () => {
    const { client, serverSide, server } = setup();
    const versions: number[] = [], off = client.onAttach(() => versions.push(client.connectionVersion));
    const before = client.connectionVersion;
    serverSide.close();
    const [c2, s2]: [Transport, Transport] = createMemoryTransportPair();
    server.connect(s2, { clientId: "t2", origin: "renderer" });
    client.attach(c2);
    expect(versions).toEqual([client.connectionVersion]); expect(client.connectionVersion).toBeGreaterThan(before);
    off();
    expect(await client.call("counts.get", {})).toMatchObject({ inboxUnread: 3 });
  });

  it("broadcasts events to every connected client", async () => {
    const { server, client } = setup();
    const [c2, s2] = createMemoryTransportPair();
    server.connect(s2, { clientId: "mcp", origin: "mcp" });
    const other = new RpcClient(c2);
    const a = vi.fn();
    const b = vi.fn();
    client.on("changed", a);
    other.on("changed", b);
    server.emit("changed", { threadIds: [1, 2], views: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(a).toHaveBeenCalledWith({ threadIds: [1, 2], views: true });
    expect(b).toHaveBeenCalledOnce();
  });

  it("enforces the authorize hook per connection origin", async () => {
    const server = new RpcServer({ "counts.get": () => ({}) } as unknown as Handlers, {
      authorize: (method, ctx) => !(ctx.origin === "mcp" && method === "counts.get"),
    });
    await expect(server.invoke("counts.get", {}, { clientId: "x", origin: "mcp" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(server.invoke("counts.get", {}, { clientId: "x", origin: "renderer" })).resolves.toEqual({});
  });
});
