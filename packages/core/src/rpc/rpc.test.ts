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
  const disconnect = server.connect(serverSide, { clientId: "t", origin: "renderer" });
  const client = new RpcClient(clientSide, { defaultTimeoutMs: 200 });
  return { server, client, clientSide, serverSide, disconnect };
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

describe("exact body part reads", () => {
  const detail = () => ({ id: 1, messages: [{ id: 7, accountId: 3, bodyText: null, bodyHtml: null, bodyReference: { version: "capture", textParts: 3, htmlParts: 0 } }] }) as unknown as import("../types").ThreadDetail;
  it("assembles exact code units, negotiates parts and reports one public operation", async () => {
    const observed = vi.fn(), parts = ["a\ud83d", "\ude00e\u0301\r", "\n\0tail"];
    const handlers = { "threads.get": (params: { bodyFormat?: string }) => { expect(params.bodyFormat).toBe("parts"); return detail(); }, "threads.bodyPart": (params: { ordinal: number }) => { expect(params).toMatchObject({ accountId: 3, messageId: 7, version: "capture", field: "text" }); return parts[params.ordinal]!; } } as unknown as Handlers;
    const actualServer = new RpcServer(handlers), [local, remote] = createMemoryTransportPair(); const disconnect = actualServer.connect(remote, { origin: "renderer", clientId: "body" });
    const client = new RpcClient(local, { observe: observed });
    try { const read = await client.call("threads.get", { threadId: 1 }); expect(read.messages[0]!.bodyText).toBe("a😀e\u0301\r\n\0tail"); expect(read.messages[0]!.bodyHtml).toBe(""); expect(read.messages[0]!.bodyReference).toBeUndefined(); await Promise.resolve(); expect(observed.mock.calls.map((call) => call[0])).toEqual(["threads.get"]); }
    finally { client.close(); disconnect(); }
  });

  for (const action of ["close", "reattach", "stale"] as const) it(`does not publish a partial exact body on ${action}`, async () => {
    let started!: () => void, release!: () => void;
    const active = new Promise<void>((resolve) => { started = resolve; }), held = new Promise<void>((resolve) => { release = resolve; });
    const { client, disconnect } = setup({ "threads.get": () => detail(), "threads.bodyPart": async ({ ordinal }) => { if (ordinal === 0) return "head"; started(); await held; if (action === "stale") throw new RpcError("STALE", "Synthetic source replacement"); return "tail"; } });
    const read = client.call("threads.get", { threadId: 1 }), outcome = read.then(() => "published", (error: RpcError) => error.code);
    await active;
    let replacement: ReturnType<typeof createMemoryTransportPair> | undefined;
    if (action === "close") client.close();
    if (action === "reattach") { replacement = createMemoryTransportPair(); client.attach(replacement[0]); }
    release();
    expect(await outcome).toBe(action === "stale" ? "STALE" : "UNAVAILABLE");
    expect(client.pendingCount).toBe(0);
    client.close(); replacement?.[1].close(); disconnect();
  });

  const wave = (textParts: number) => ({ id: 1, messages: [{ id: 7, accountId: 3, bodyText: null, bodyHtml: null, bodyReference: { version: "capture", textParts, htmlParts: null } }] }) as unknown as import("../types").ThreadDetail;
  const after = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  it("reads parts a few at a time and reassembles them exactly, whatever order they answer in", async () => {
    const texts = ["a\ud83d", "\ude00b", "c\r", "\nd", "", "e\u0301", "f", "g", "h", "i\ud83d", "\ude00"], htmls = ["<p>", "x", "</p>"];
    let active = 0, peak = 0;
    const answered: string[] = [];
    const part = async ({ messageId, field, ordinal }: { messageId: number; field: "text" | "html"; ordinal: number }) => {
      active++; peak = Math.max(peak, active);
      // earlier ordinals answer later
      await after(ordinal % 4 === 0 ? 6 : ordinal % 4 === 1 ? 4 : 1);
      active--; answered.push(`${messageId}${field}${ordinal}`);
      return (messageId === 7 && field === "text" ? texts : htmls)[ordinal]!;
    };
    const { client, disconnect } = setup({
      "threads.get": () => ({ id: 1, messages: [
        { id: 7, accountId: 3, bodyText: null, bodyHtml: null, bodyReference: { version: "a", textParts: texts.length, htmlParts: null } },
        { id: 8, accountId: 3, bodyText: "inline", bodyHtml: "inline" },
        { id: 9, accountId: 3, bodyText: null, bodyHtml: null, bodyReference: { version: "b", textParts: 0, htmlParts: htmls.length } },
      ] }) as never,
      "threads.bodyPart": part as never,
    });
    try {
      const read = await client.call("threads.get", { threadId: 1 });
      expect(read.messages[0]).toMatchObject({ bodyText: texts.join(""), bodyHtml: null });
      expect(read.messages[0]!.bodyReference).toBeUndefined();
      expect(read.messages[1]).toMatchObject({ bodyText: "inline", bodyHtml: "inline" });
      expect(read.messages[2]).toMatchObject({ bodyText: "", bodyHtml: htmls.join("") });
      expect(peak).toBe(4);
      expect(answered.indexOf("7text1")).toBeLessThan(answered.indexOf("7text0"));
      expect(client.pendingCount).toBe(0);
    } finally { client.close(); disconnect(); }
  });

  it("a part refused in a later wave ends the read at once: its own requests dropped, no more parts begun, other calls untouched", async () => {
    const started: number[] = [];
    let release!: () => void, unrelated!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; }), elsewhere = new Promise<void>((resolve) => { unrelated = resolve; });
    const { client, disconnect } = setup({
      "threads.get": () => wave(16),
      "threads.bodyPart": (async ({ ordinal }: { ordinal: number }) => {
        started.push(ordinal);
        if (ordinal < 4) return "x";
        if (ordinal === 4) { await after(1); throw new RpcError("STALE", "Synthetic source replacement"); }
        await held;
        return "late";
      }) as never,
      "counts.get": (async () => { await elsewhere; return { inboxUnread: 1, inboxUnreadByAccount: {}, categoryUnread: {}, categoryTotal: {}, categorySuggestions: {} }; }) as never,
    });
    try {
      const other = client.call("counts.get", {});
      await expect(client.call("threads.get", { threadId: 1 })).rejects.toMatchObject({ code: "STALE" });
      expect(client.pendingCount).toBe(1);
      // its siblings were in flight beside it when it failed
      expect(started).toEqual(expect.arrayContaining([5, 6, 7]));
      const begun = started.length;
      expect(begun).toBeLessThan(16);
      release();
      await after(5);
      expect(started).toHaveLength(begun);
      unrelated();
      await expect(other).resolves.toMatchObject({ inboxUnread: 1 });
    } finally { client.close(); disconnect(); }
  });

  it("parts not yet asked for never reach a replacement connection", async () => {
    let release!: () => void, waiting!: () => void, holding = 0;
    const held = new Promise<void>((resolve) => { release = resolve; }), reached = new Promise<void>((resolve) => { waiting = resolve; });
    const { client, disconnect } = setup({
      "threads.get": () => wave(16),
      // a whole wave is in flight when the connection changes
      "threads.bodyPart": (async ({ ordinal }: { ordinal: number }) => { if (ordinal < 4) return "x"; if (++holding === 4) waiting(); await held; return "late"; }) as never,
    });
    const read = client.call("threads.get", { threadId: 1 }).then(() => "published", (error: RpcError) => error.code);
    await reached;
    const [local, remote] = createMemoryTransportPair();
    const seen: string[] = [];
    remote.onMessage((message) => { if (message.t === "req") seen.push(message.m); });
    client.attach(local);
    release();
    expect(await read).toBe("UNAVAILABLE");
    await after(5);
    expect(seen).toEqual([]);
    expect(client.pendingCount).toBe(0);
    client.close(); remote.close(); disconnect();
  });

  it("the deadline covers the whole read, past an earlier wave that answered", async () => {
    const started: number[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const { client, disconnect } = setup({
      "threads.get": () => wave(16),
      "threads.bodyPart": (async ({ ordinal }: { ordinal: number }) => { started.push(ordinal); if (ordinal >= 4) await held; return "x"; }) as never,
    });
    try {
      await expect(client.call("threads.get", { threadId: 1 })).rejects.toMatchObject({ code: "TIMEOUT" });
      expect(client.pendingCount).toBe(0);
      const begun = started.length;
      // the first wave, then a second held whole
      expect(begun).toBe(8);
      release();
      await after(5);
      expect(started).toHaveLength(begun);
    } finally { release(); client.close(); disconnect(); }
  });

  it("keeps the original whole-read deadline while a real part handler is held", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const { client, disconnect } = setup({ "threads.get": () => detail(), "threads.bodyPart": async () => { await held; return "late"; } });
    try { await expect(client.call("threads.get", { threadId: 1 })).rejects.toMatchObject({ code: "TIMEOUT" }); expect(client.pendingCount).toBe(0); }
    finally { release(); client.close(); disconnect(); }
  });
});
