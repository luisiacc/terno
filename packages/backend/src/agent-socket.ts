import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { AgentFiles, agentFilesDir } from "./agent-files";
import type { BackendCore } from "./core";

/**
 * Plan 293: serves one authenticated agent on its socket (the token line already read). `rpc` reaches this backend
 * as origin `mcp`, so every call goes through the agent gate. The desktop gives packages/mcp's serveMcp: the MCP
 * server runs here, in the app, and the agent's command is only a stdio-to-socket bridge. Resolves once it's reading.
 */
export type AgentServe = (socket: Socket, rpc: RpcClient) => Promise<void>;

export interface AgentEndpoint {
  socketPath: string;
  tokenPath: string;
  /** agents connected right now */
  connected(): number;
  /** when the current token was written */
  tokenSince(): number;
  /** a new token in the file; every connected agent is cut off (it must read the new one to come back) */
  rotate(): { disconnected: number; tokenSince: number };
  close(): Promise<void>;
  /** plan 185: copies of files handed to agents, gone when the endpoint closes or the token changes */
  files: AgentFiles;
}

/**
 * Local endpoint for the agents' bridge. Unix socket + a random token in a 0600
 * file next to it: only processes of this user that can read the token file
 * can talk to the backend. The first line on a connection must be the token;
 * after `{"ok":true}`, the connection is `serve`'s (plan 293: an MCP session).
 * Plan 183: started and closed by the AgentConnector as the user turns agents on and off.
 */
export async function startAgentSocket(backend: BackendCore, socketPath: string, tokenPath: string, serve: AgentServe): Promise<AgentEndpoint> {
  let token = "";
  let since = 0;
  let closing = false;
  const writeToken = () => {
    token = randomBytes(32).toString("hex");
    writeFileSync(tokenPath, token, { mode: 0o600 });
    chmodSync(tokenPath, 0o600);
    since = backend.now();
  };
  const removeFiles = () => {
    rmSync(tokenPath, { force: true });
    rmSync(socketPath, { force: true });
  };
  let clients = 0;
  // every accepted connection, so closing cuts the ones still in their handshake too (plan 183, Codex review #2)
  const accepted = new Set<Socket>();
  const live = new Set<Socket>();
  // half-open: the bridge ends its side when the agent's stdin does, and still reads the last answers (plan 293)
  const server: Server = createServer({ allowHalfOpen: true }, (socket) => {
    if (closing) {
      socket.destroy();
      return;
    }
    accepted.add(socket);
    socket.once("close", () => {
      accepted.delete(socket);
      live.delete(socket);
    });
    socket.on("error", () => {});
    let authed = false;
    // bytes, not text: a chunk can end inside a UTF-8 character of what follows the token
    let pending = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      const nl = pending.indexOf(0x0a);
      if (nl === -1) {
        if (pending.length > 1024) socket.destroy();
        return;
      }
      const offered = Buffer.from(pending.subarray(0, nl).toString("utf8").trim());
      const expected = Buffer.from(token);
      if (closing || offered.length !== expected.length || !timingSafeEqual(offered, expected)) {
        socket.end('{"error":"unauthorized"}\n');
        return;
      }
      authed = true;
      live.add(socket);
      socket.off("data", onData);
      socket.pause();
      const rest = pending.subarray(nl + 1);
      if (rest.length) socket.unshift(rest);
      const [ours, theirs] = createMemoryTransportPair();
      const disconnect = backend.connect(theirs, { clientId: `mcp-${++clients}`, origin: "mcp" });
      socket.once("close", () => {
        ours.close();
        disconnect();
      });
      socket.write('{"ok":true}\n');
      serve(socket, new RpcClient(ours, { defaultTimeoutMs: 60_000 })).then(
        () => socket.resume(),
        () => socket.destroy(),
      );
    };
    socket.on("data", onData);
    setTimeout(() => {
      if (!authed) socket.destroy();
    }, 5000).unref();
  });
  const files = new AgentFiles(agentFilesDir(tokenPath));
  // what a crash or an older run left
  await files.clear();
  writeToken();
  if (existsSync(socketPath)) rmSync(socketPath);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => resolve());
    });
    chmodSync(socketPath, 0o600);
  } catch (error) {
    // nothing left behind that says agents can connect (Codex review #9)
    server.close();
    removeFiles();
    await files.clear();
    throw error;
  }
  const endpoint: AgentEndpoint = {
    socketPath,
    tokenPath,
    connected: () => live.size,
    tokenSince: () => since,
    files,
    rotate: () => {
      writeToken();
      // cutting every agent off takes back the copies they were given
      void files.clear().catch(() => {});
      const cut = [...live];
      for (const socket of cut) socket.destroy();
      live.clear();
      return { disconnected: cut.length, tokenSince: since };
    },
    close: () =>
      new Promise<void>((resolve) => {
        closing = true;
        if (backend.agents === endpoint) backend.agents = null;
        for (const socket of accepted) socket.destroy();
        removeFiles();
        // the copies go after the writes in flight see they were cut off
        void Promise.all([new Promise<void>((done) => server.close(() => done())), files.close().catch(() => {})]).then(() => resolve());
      }),
  };
  backend.agents = endpoint;
  return endpoint;
}
