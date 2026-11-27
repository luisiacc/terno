import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { createAccount, setSetting, sqlDb } from "@terno/db";
import { demoRegistry } from "@terno/mail";
import { afterEach, describe, expect, it } from "vitest";
import { startAgentSocket, type AgentServe } from "./agent-socket";
import { Backend, plaintextCipher } from "./backend";
import { readSettings } from "./settings";

const NOW = Date.UTC(2026, 10, 11, 12);
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** Plan 293: the socket's session for these tests: each line `{ id, method, params }` is called through `rpc` (origin mcp). */
const lineSession: AgentServe = async (socket, rpc) => {
  let buffer = "";
  socket.setEncoding("utf8").on("data", (d: string) => {
    buffer += d;
    for (let nl = buffer.indexOf("\n"); nl !== -1; nl = buffer.indexOf("\n")) {
      const m = JSON.parse(buffer.slice(0, nl)) as { id: number; method: "app.bootstrap"; params: {} };
      buffer = buffer.slice(nl + 1);
      rpc.call(m.method, m.params).then(
        (result) => socket.write(`${JSON.stringify({ id: m.id, result })}\n`),
        (error: Error) => socket.write(`${JSON.stringify({ id: m.id, error: error.message })}\n`),
      );
    }
  });
};

/** One call on a session socket. */
function ask(sock: ReturnType<typeof connect>, method: string, params: unknown): Promise<{ result?: any; error?: string }> {
  return new Promise((resolve) => {
    sock.setEncoding("utf8").once("data", (d: string) => resolve(JSON.parse(d)));
    sock.write(`${JSON.stringify({ id: 1, method, params })}\n`);
  });
}

/** A backend with the connector (as on the desktop), a renderer, and an agent on a memory transport. */
async function setup(o: { stored?: Record<string, unknown>; start?: typeof startAgentSocket } = {}) {
  // short: unix socket paths are limited to ~104 bytes on macOS
  const dir = mkdtempSync(join("/tmp", "tagent-"));
  const paths = { socketPath: join(dir, "a.sock"), tokenPath: join(dir, "a.token"), serve: lineSession };
  const backend = new Backend({ dbPath: join(dir, "t.db"), version: "test", cipher: plaintextCipher, providers: demoRegistry, autoSync: false, now: () => NOW, agentEndpoint: paths });
  if (o.start) (backend.agentConnector as unknown as { start: typeof startAgentSocket }).start = o.start;
  await backend.store.ready;
  if (o.stored) setSetting(sqlDb(backend.store), "app", o.stored);
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: "renderer", origin: "renderer" });
  const client = new RpcClient(c);
  const [mc, ms] = createMemoryTransportPair();
  backend.connect(ms, { clientId: "agent", origin: "mcp" });
  const agent = new RpcClient(mc);
  const accountId = createAccount(sqlDb(backend.store), { kind: "imap", email: "me@example.com", displayName: "Me", color: "brown" }).id;
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await backend.stop().catch(() => {});
  };
  cleanups.push(async () => {
    await stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const set = (agents: { enabled?: boolean; access?: "read" | "organize" | "send" }) => client.call("settings.update", { agents });
  const handshake = (token: string) =>
    new Promise<{ sock: ReturnType<typeof connect>; reply: string }>((resolve, reject) => {
      const sock = connect(paths.socketPath);
      sock.once("error", reject);
      sock.once("data", (d) => resolve({ sock, reply: String(d) })).write(`${token}\n`);
    });
  return { backend, client, agent, accountId, paths, set, handshake, stop, dir };
}

describe("plan 183: the setting", () => {
  it("is on on a fresh profile, at read (owner, 2026-11-24): an untouched agent reads and changes nothing", async () => {
    const { client, agent } = await setup();
    expect((await client.call("app.bootstrap", {})).settings.agents).toEqual({ enabled: true, access: "read" });
    await expect(agent.call("threads.search", { query: "x" })).resolves.toBeTruthy();
    await expect(agent.call("threads.act", { threadIds: [1], action: "archive" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("a profile from before plan 183, or one seeded before its first start, takes the default: read only, whatever it allowed", async () => {
    const before = await setup({ stored: { density: "compact" } });
    expect((await readSettings(before.backend.store)).agents).toEqual({ enabled: true, access: "read" });
    const sender = await setup({ stored: { density: "compact", allowAgentSend: true } });
    expect((await readSettings(sender.backend.store)).agents).toEqual({ enabled: true, access: "read" });
    // stamped once: what the user chooses next is kept
    await sender.set({ enabled: false, access: "organize" });
    expect((await readSettings(sender.backend.store)).agents).toEqual({ enabled: false, access: "organize" });
    expect(sqlDb(sender.backend.store).get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = 'app'")!.value_json).not.toContain("allowAgentSend");
  });

  it("a partial patch keeps the other field", async () => {
    const { set, client } = await setup();
    await set({ enabled: false });
    await set({ access: "organize" });
    expect((await client.call("app.bootstrap", {})).settings.agents).toEqual({ enabled: false, access: "organize" });
    await set({ enabled: true });
    expect((await client.call("app.bootstrap", {})).settings.agents).toEqual({ enabled: true, access: "organize" });
  });
});

describe("plan 183: the gate", () => {
  it("refuses everything while agents are off, saying where to turn them on", async () => {
    const { agent, set } = await setup();
    await set({ enabled: false });
    await expect(agent.call("app.bootstrap", {})).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringMatching(/Settings → Agents/) });
  });

  it("each level reaches its own methods and those below, never more", async () => {
    const { agent, set, accountId } = await setup();
    const archive = () => agent.call("threads.act", { threadIds: [1], action: "archive" });
    const draft = () => agent.call("drafts.save", { accountId, to: [], cc: [], subject: "s", bodyText: "b" });
    const send = () => agent.call("compose.send", { accountId, to: [{ name: "", email: "a@b.co" }], subject: "x", bodyText: "y" });

    await set({ enabled: true, access: "read" });
    await expect(agent.call("threads.search", { query: "x" })).resolves.toBeTruthy();
    await expect(agent.call("filters.list", {})).resolves.toBeTruthy();
    await expect(archive()).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringMatching(/Read and organize/) });
    await expect(draft()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(send()).rejects.toMatchObject({ code: "FORBIDDEN" });

    await set({ access: "organize" });
    await expect(draft()).resolves.toMatchObject({ id: expect.any(Number) });
    await expect(send()).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringMatching(/create_draft/) });

    await set({ access: "send" });
    await expect(send()).resolves.toMatchObject({ opId: expect.any(String) });
    // never: what isn't in the table, at any level
    await expect(agent.call("settings.update", { agents: { access: "send" } })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(agent.call("agents.rotateToken", {})).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(agent.call("accounts.remove", { id: accountId })).rejects.toMatchObject({ code: "FORBIDDEN" });

    // off again: a connection that outlived the switch gets nothing
    await set({ enabled: false });
    await expect(agent.call("threads.search", { query: "x" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("an import can turn agents off, never on, and never changes the level", async () => {
    const { client, set, backend, paths } = await setup();
    await backend.start();
    const dump = await client.call("app.export", {});
    await set({ enabled: true, access: "organize" });
    await client.call("app.import", { data: { ...dump, settings: { ...dump.settings, agents: { enabled: true, access: "send" } } } });
    expect((await client.call("app.bootstrap", {})).settings.agents).toEqual({ enabled: true, access: "organize" });
    await client.call("app.import", { data: { ...dump, settings: { ...dump.settings, agents: { enabled: false, access: "send" } } } });
    expect((await client.call("app.bootstrap", {})).settings.agents).toEqual({ enabled: false, access: "organize" });
    // and the live connector closes with it
    expect(existsSync(paths.socketPath)).toBe(false);
    expect(existsSync(paths.tokenPath)).toBe(false);
  });
});

describe("plan 183: the connector", () => {
  it("off: no socket and no token file, and one an older build left goes at start", async () => {
    const { backend, paths, client, set } = await setup();
    await set({ enabled: false });
    writeFileSync(paths.tokenPath, "stale");
    await backend.start();
    expect(existsSync(paths.tokenPath)).toBe(false);
    expect(existsSync(paths.socketPath)).toBe(false);
    expect(await client.call("agents.status", {})).toEqual({ available: true, enabled: false, running: false, connected: 0, tokenSince: null });
  });

  it("on (a fresh profile's start): the socket answers the token; off: the agent is cut and both files go", async () => {
    const { backend, paths, set, client, handshake } = await setup();
    await backend.start();
    expect((await handshake("nope")).reply).toContain("unauthorized");
    const { sock, reply } = await handshake(readFileSync(paths.tokenPath, "utf8"));
    expect(reply).toContain('"ok":true');
    // plan 293: the session runs on the in-process client, so the call arrives as an agent's
    expect((await ask(sock, "app.bootstrap", {})).result).toMatchObject({ version: "test" });
    expect(await client.call("agents.status", {})).toEqual({ available: true, enabled: true, running: true, connected: 1, tokenSince: NOW });

    const closed = new Promise<void>((r) => sock.once("close", () => r()));
    await set({ enabled: false });
    await closed;
    expect(existsSync(paths.tokenPath)).toBe(false);
    expect(existsSync(paths.socketPath)).toBe(false);
    expect(await client.call("agents.status", {})).toMatchObject({ enabled: false, running: false, connected: 0 });
  });

  it("turning agents off cuts a connection still in its handshake (Codex critique #2)", async () => {
    const { backend, paths, set } = await setup();
    await backend.start();
    await set({ enabled: true });
    const pending = connect(paths.socketPath);
    await new Promise<void>((r) => pending.once("connect", () => r()));
    const closed = new Promise<void>((r) => pending.once("close", () => r()));
    await set({ enabled: false });
    await closed;
    expect(existsSync(paths.socketPath)).toBe(false);
  });

  it("on, off, on in quick succession: one listener and a fresh token", async () => {
    const { backend, paths, set, handshake } = await setup();
    await backend.start();
    await set({ enabled: true });
    const first = readFileSync(paths.tokenPath, "utf8");
    await Promise.all([set({ enabled: false }), set({ enabled: true })]);
    const second = readFileSync(paths.tokenPath, "utf8");
    expect(second).not.toBe(first);
    expect((await handshake(first)).reply).toContain("unauthorized");
    const ok = await handshake(second);
    expect(ok.reply).toContain('"ok":true');
    ok.sock.destroy();
  });

  it("a start that fails leaves no file, says so, and the next switch retries (Codex critique #9)", async () => {
    let fail = true;
    const { backend, paths, set, client } = await setup({
      start: (b, socketPath, tokenPath) => (fail ? Promise.reject(Object.assign(new Error("in use"), { code: "EADDRINUSE" })) : startAgentSocket(b, socketPath, tokenPath, lineSession)),
    });
    await backend.start();
    expect(await client.call("agents.status", {})).toMatchObject({ enabled: true, running: false });
    expect(backend.agentConnector!.failed()).toBe(true);
    expect(existsSync(paths.tokenPath)).toBe(false);
    fail = false;
    await set({ enabled: false });
    await set({ enabled: true });
    expect(await client.call("agents.status", {})).toMatchObject({ enabled: true, running: true });
  });

  it("stop fences a start still in flight (Codex critique #8)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { backend, paths, set, stop } = await setup({ start: async (b, s, t) => (await gate, startAgentSocket(b, s, t, lineSession)) });
    await set({ enabled: false });
    await backend.start();
    const turningOn = set({ enabled: true });
    await new Promise((r) => setTimeout(r, 20));
    const stopping = stop();
    release();
    await turningOn.catch(() => {});
    await stopping;
    expect(existsSync(paths.tokenPath)).toBe(false);
    expect(existsSync(paths.socketPath)).toBe(false);
    expect(backend.agents).toBeNull();
  });

  it("a host without the connector (the web) says it isn't available", async () => {
    const dir = mkdtempSync(join("/tmp", "tagent-"));
    const backend = new Backend({ dbPath: join(dir, "t.db"), version: "test", cipher: plaintextCipher, providers: demoRegistry, autoSync: false });
    cleanups.push(async () => {
      await backend.stop();
      rmSync(dir, { recursive: true, force: true });
    });
    expect(await backend.server.invoke("agents.status", {}, { clientId: "r", origin: "renderer" })).toEqual({ available: false, enabled: true, running: false, connected: 0, tokenSince: null });
  });
});
