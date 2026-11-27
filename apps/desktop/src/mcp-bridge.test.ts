import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { Backend, plaintextCipher, seedDemo } from "@terno/backend";
import { demoRegistry } from "@terno/mail";
import { LOST, NOT_RUNNING, offlineManifest, REJECTED, serveMcp, type OfflineManifest } from "@terno/mcp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error a build script (plain JS)
import { bridgeCompiler, buildBridge } from "../scripts/mcp-bridge.mjs";

// Plan 293 (CASA 6.2.1): the agents' command is a native bridge to the MCP server inside the app. Compiled here with the
// host's compiler, from this tree's server, and run as an agent runs it: stdio in, stdio out.

const host = process.platform === "darwin" ? { os: "darwin", arch: "arm64" } : { os: "linux", arch: process.arch };
const compiler = spawnSync(process.platform === "darwin" ? "cc" : "gcc", ["--version"]).status === 0;
// short: unix socket paths are limited to ~104 bytes on macOS
const dir = mkdtempSync(join("/tmp", "tbridge-"));
const paths = { socketPath: join(dir, "a.sock"), tokenPath: join(dir, "a.token") };
const bridge = join(dir, "terno-mcp");
let manifest: OfflineManifest;
let backend: Backend | null = null;

const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "agent", version: "1" } } };
const INITIALIZED = { jsonrpc: "2.0", method: "notifications/initialized" };
const call = (id: number | string, name: string, args: Record<string, unknown> = {}) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

/** The bridge as an agent runs it, with this test's socket and token. */
class Agent {
  readonly child: ChildProcessWithoutNullStreams;
  private out = "";
  private waiters: (() => void)[] = [];
  readonly exited: Promise<number | null>;
  constructor(env: Record<string, string> = {}) {
    this.child = spawn(bridge, [], { env: { PATH: process.env.PATH ?? "", HOME: dir, TERNO_SOCKET: paths.socketPath, TERNO_TOKEN_FILE: paths.tokenPath, ...env } });
    // a bridge that refuses what it's sent exits mid-write: that's the point, not an error here
    this.child.stdin.on("error", () => {});
    this.child.stdout.setEncoding("utf8").on("data", (d: string) => {
      this.out += d;
      for (const w of this.waiters.splice(0)) w();
    });
    this.exited = new Promise((r) => this.child.on("close", (code) => r(code)));
  }
  send(...messages: unknown[]): void {
    this.child.stdin.write(messages.map((m) => `${typeof m === "string" ? m : JSON.stringify(m)}\n`).join(""));
  }
  /** every whole line written so far */
  lines(): any[] {
    return this.out.split("\n").slice(0, -1).map((l) => JSON.parse(l));
  }
  /** waits for the answer to `id` */
  async answer(id: number | string, ms = 10_000): Promise<any> {
    const until = Date.now() + ms;
    for (;;) {
      const found = this.lines().find((m) => m.id === id);
      if (found) return found;
      if (Date.now() > until) throw new Error(`no answer to ${id}: ${this.out}`);
      await new Promise<void>((r) => {
        this.waiters.push(r);
        setTimeout(r, 200);
      });
    }
  }
  async end(): Promise<number | null> {
    this.child.stdin.end();
    return this.exited;
  }
}

async function startTerno(): Promise<Backend> {
  const b = new Backend({ dbPath: join(dir, "t.db"), version: "t", cipher: plaintextCipher, providers: demoRegistry, autoSync: false, agentEndpoint: { ...paths, serve: (s, rpc) => serveMcp(s, rpc, "t") } });
  await b.store.ready;
  if (!(await b.store.accounts.list()).length) await seedDemo(b.store, { threads: 20, accounts: 2 });
  await b.start();
  backend = b;
  return b;
}

async function stopTerno(): Promise<void> {
  await backend?.stop();
  backend = null;
}

const text = (answer: any): string => answer.result.content[0].text;

describe.skipIf(!compiler)("the agents' bridge (plan 293)", () => {
  beforeAll(async () => {
    manifest = await offlineManifest("t");
    buildBridge({ manifest, target: host, out: bridge, compiler: { ...bridgeCompiler(host), cc: host.os === "darwin" ? "cc" : "gcc" } });
  }, 60_000);

  afterAll(async () => {
    await stopTerno();
    rmSync(dir, { recursive: true, force: true });
  });

  it("while Terno is closed, answers as the server did: initialize, the real tools, ping, and 'Open Terno' on a call", async () => {
    const agent = new Agent();
    agent.send(INIT, INITIALIZED, { jsonrpc: "2.0", id: 2, method: "tools/list" }, { jsonrpc: "2.0", id: 3, method: "ping" }, call(4, "list_accounts"), { jsonrpc: "2.0", id: 5, method: "resources/list" });
    const init = await agent.answer(1);
    expect(init.result).toEqual({ protocolVersion: "2025-06-18", ...manifest.initialize });
    expect((await agent.answer(2)).result.tools).toEqual(manifest.tools);
    expect((await agent.answer(3)).result).toEqual({});
    const offline = await agent.answer(4);
    expect(offline.result.isError).toBe(true);
    expect(text(offline)).toBe(NOT_RUNNING);
    expect((await agent.answer(5)).error.code).toBe(-32601);
    expect(await agent.end()).toBe(0);
    // nothing but the answers, one per request (the notification got none)
    expect(agent.lines().map((m) => m.id)).toEqual([1, 2, 3, 4, 5]);
  });

  it("negotiates the protocol version as the SDK does: the client's when supported, else the latest", async () => {
    const agent = new Agent();
    agent.send({ ...INIT, params: { ...INIT.params, protocolVersion: "1999-01-01" } });
    expect((await agent.answer(1)).result.protocolVersion).toBe(manifest.latestVersion);
    await agent.end();
  });

  it("a session started before Terno opened works once it does, with nothing extra on stdout", async () => {
    const agent = new Agent();
    agent.send(INIT, INITIALIZED, call(2, "list_accounts"));
    expect(text(await agent.answer(2))).toBe(NOT_RUNNING);
    await startTerno();
    try {
      agent.send(call("three", "list_accounts"));
      const online = await agent.answer("three");
      expect(online.result.isError).toBeFalsy();
      expect(JSON.parse(text(online)).accounts).toHaveLength(2);
      // the replayed initialize's answer never reaches the agent
      expect(agent.lines().map((m) => m.id)).toEqual([1, 2, "three"]);
    } finally {
      await agent.end();
      await stopTerno();
    }
  });

  it("answers the last call before the agent's end, then exits (it half-closes, the app finishes)", async () => {
    await startTerno();
    try {
      const agent = new Agent();
      agent.send(INIT, INITIALIZED, call(2, "list_accounts"));
      expect(await agent.end()).toBe(0);
      expect(JSON.parse(text(agent.lines().find((m) => m.id === 2))).accounts).toHaveLength(2);
    } finally {
      await stopTerno();
    }
  });

  it("Terno quitting mid-call: the call's outcome is unknown, and later calls say to open Terno", async () => {
    await startTerno();
    const agent = new Agent();
    try {
      agent.send(INIT, INITIALIZED, call(2, "list_accounts"));
      await agent.answer(2);
      // a wait that's still running when Terno quits
      agent.send(call(3, "wait_for_new_mail", { accountId: 1, waitSeconds: 30 }));
      await new Promise((r) => setTimeout(r, 300));
      await stopTerno();
      const lost = await agent.answer(3);
      expect(lost.result.isError).toBe(true);
      expect(text(lost)).toBe(LOST);
      agent.send(call(4, "list_accounts"));
      expect(text(await agent.answer(4))).toBe(NOT_RUNNING);
    } finally {
      await agent.end();
    }
  });

  it("a cancelled call is no longer in flight: the agent's end doesn't wait for it", async () => {
    await startTerno();
    try {
      const agent = new Agent();
      agent.send(INIT, INITIALIZED, call(2, "wait_for_new_mail", { accountId: 1, waitSeconds: 30 }));
      await new Promise((r) => setTimeout(r, 300));
      agent.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 2 } });
      const started = Date.now();
      expect(await agent.end()).toBe(0);
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      await stopTerno();
    }
  });

  it("an answer cut off by Terno quitting never reaches the agent as half a line: the call is answered as lost (Codex code review #9)", async () => {
    // a fake app that starts an answer and dies mid-line
    const sock = join(dir, "half.sock");
    const server = createServer((s) => {
      let authed = false;
      s.on("data", (d) => {
        if (!authed) {
          authed = true;
          s.write('{"ok":true}\n');
          return;
        }
        if (String(d).includes('"tools/call"')) s.end('{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"cut off');
      });
    });
    await new Promise<void>((r) => server.listen(sock, () => r()));
    writeFileSync(join(dir, "half.token"), "t");
    try {
      const agent = new Agent({ TERNO_SOCKET: sock, TERNO_TOKEN_FILE: join(dir, "half.token") });
      agent.send(INIT, INITIALIZED, call(2, "list_accounts"));
      expect(text(await agent.answer(2))).toBe(LOST);
      await agent.end();
      // every line the agent got is whole JSON (lines() parses each)
      expect(agent.lines().every((l) => typeof l === "object")).toBe(true);
    } finally {
      server.close();
    }
  });

  it("a message past the bound ends the session plainly instead of wedging it (Codex code review #2)", async () => {
    await startTerno();
    try {
      const agent = new Agent();
      agent.send(INIT, INITIALIZED);
      await agent.answer(1);
      // 17 MiB without a newline: the bridge refuses it (the app would close the session at 16 MiB)
      agent.child.stdin.write("x".repeat(17 * 1024 * 1024));
      expect(await agent.exited).toBe(1);
    } finally {
      await stopTerno();
    }
  });

  it("a token the app refuses says so", async () => {
    const server = createServer((s) => s.once("data", () => s.end('{"error":"unauthorized"}\n')));
    const sock = join(dir, "r.sock");
    await new Promise<void>((r) => server.listen(sock, () => r()));
    writeFileSync(join(dir, "r.token"), "old");
    try {
      const agent = new Agent({ TERNO_SOCKET: sock, TERNO_TOKEN_FILE: join(dir, "r.token") });
      agent.send(INIT, call(2, "list_accounts"));
      expect(text(await agent.answer(2))).toBe(REJECTED);
      await agent.end();
    } finally {
      server.close();
    }
  });

  it("finds the profile's socket and token through TERNO_USER_DATA, as the app writes them", async () => {
    const profile = mkdtempSync(join("/tmp", "tbprof-"));
    const before = { ...paths };
    Object.assign(paths, { socketPath: join(profile, "agent.sock"), tokenPath: join(profile, "agent.token") });
    try {
      await startTerno();
      const agent = new Agent({ TERNO_SOCKET: "", TERNO_TOKEN_FILE: "", TERNO_USER_DATA: profile });
      agent.send(INIT, INITIALIZED, call(2, "list_accounts"));
      expect((await agent.answer(2)).result.isError).toBeFalsy();
      await agent.end();
    } finally {
      await stopTerno();
      Object.assign(paths, before);
      rmSync(profile, { recursive: true, force: true });
    }
  });

  it("carries ids it must give back exactly, a line split across writes, and text outside ASCII", async () => {
    const agent = new Agent();
    const line = JSON.stringify({ ...call("aé\\/b", "list_accounts") });
    agent.send(INIT);
    agent.child.stdin.write(line.slice(0, 10));
    await new Promise((r) => setTimeout(r, 50));
    agent.child.stdin.write(`${line.slice(10)}\n`);
    const answer = await agent.answer("aé\\/b");
    expect(text(answer)).toBe(NOT_RUNNING);
    // the offline message's own non-ASCII (the arrows) arrives as written
    expect(text(answer)).toContain("Settings → Agents");
    await agent.end();
  });
});
