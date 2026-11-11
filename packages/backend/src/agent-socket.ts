import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { AgentFiles, agentFilesDir } from "./agent-files";
import type { BackendCore } from "./core";
import { socketTransport } from "./transports";

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
 * Local endpoint for the MCP sidecar. Unix socket + a random token in a 0600
 * file next to it: only processes of this user that can read the token file
 * can talk to the backend. The first line on a connection must be the token.
 * Plan 183: started and closed by the AgentConnector as the user turns agents on and off.
 */
export async function startAgentSocket(backend: BackendCore, socketPath: string, tokenPath: string): Promise<AgentEndpoint> {
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
  const server: Server = createServer((socket) => {
    if (closing) {
      socket.destroy();
      return;
    }
    accepted.add(socket);
    socket.once("close", () => {
      accepted.delete(socket);
      live.delete(socket);
    });
    let authed = false;
    let pending = "";
    const onData = (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      const nl = pending.indexOf("\n");
      if (nl === -1) {
        if (pending.length > 1024) socket.destroy();
        return;
      }
      const offered = Buffer.from(pending.slice(0, nl).trim());
      const expected = Buffer.from(token);
      if (closing || offered.length !== expected.length || !timingSafeEqual(offered, expected)) {
        socket.end('{"error":"unauthorized"}\n');
        return;
      }
      authed = true;
      live.add(socket);
      socket.off("data", onData);
      const rest = pending.slice(nl + 1);
      const transport = socketTransport(socket);
      backend.connect(transport, { clientId: `mcp-${++clients}`, origin: "mcp" });
      socket.write('{"ok":true}\n');
      if (rest) socket.emit("data", rest);
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
