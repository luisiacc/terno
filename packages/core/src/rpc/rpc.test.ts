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

  it("can reattach to a new transport after a backend restart", async () => {
    const { client, serverSide, server } = setup();
    serverSide.close();
    const [c2, s2]: [Transport, Transport] = createMemoryTransportPair();
    server.connect(s2, { clientId: "t2", origin: "renderer" });
    client.attach(c2);
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
