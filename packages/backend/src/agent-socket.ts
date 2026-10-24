import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import type { Backend } from "./backend";
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
}

/**
 * Local endpoint for the MCP sidecar. Unix socket + a random token in a 0600
 * file next to it: only processes of this user that can read the token file
 * can talk to the backend. The first line on a connection must be the token.
 */
export async function startAgentSocket(backend: Backend, socketPath: string, tokenPath: string): Promise<AgentEndpoint> {
  let token = "";
  let since = 0;
  const writeToken = () => {
    token = randomBytes(32).toString("hex");
    writeFileSync(tokenPath, token, { mode: 0o600 });
    chmodSync(tokenPath, 0o600);
    since = backend.now();
  };
  writeToken();
  if (existsSync(socketPath)) rmSync(socketPath);
  let clients = 0;
  const live = new Set<Socket>();
  const server: Server = createServer((socket) => {
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
      if (offered.length !== expected.length || !timingSafeEqual(offered, expected)) {
        socket.end('{"error":"unauthorized"}\n');
        return;
      }
      authed = true;
      live.add(socket);
      socket.once("close", () => live.delete(socket));
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
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  chmodSync(socketPath, 0o600);
  const endpoint: AgentEndpoint = {
    socketPath,
    tokenPath,
    connected: () => live.size,
    tokenSince: () => since,
    rotate: () => {
      writeToken();
      const cut = [...live];
      for (const socket of cut) socket.destroy();
      live.clear();
      return { disconnected: cut.length, tokenSince: since };
    },
    close: () =>
      new Promise<void>((resolve) => {
        if (backend.agents === endpoint) backend.agents = null;
        for (const socket of live) socket.destroy();
        server.close(() => resolve());
        rmSync(tokenPath, { force: true });
      }),
  };
  backend.agents = endpoint;
  return endpoint;
}
