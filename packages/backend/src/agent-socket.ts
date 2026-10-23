import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import type { Backend } from "./backend";
import { socketTransport } from "./transports";

export interface AgentEndpoint {
  socketPath: string;
  tokenPath: string;
  close(): Promise<void>;
}

/**
 * Local endpoint for the MCP sidecar. Unix socket + a random token in a 0600
 * file next to it: only processes of this user that can read the token file
 * can talk to the backend. The first line on a connection must be the token.
 */
export async function startAgentSocket(backend: Backend, socketPath: string, tokenPath: string): Promise<AgentEndpoint> {
  const token = randomBytes(32).toString("hex");
  writeFileSync(tokenPath, token, { mode: 0o600 });
  chmodSync(tokenPath, 0o600);
  if (existsSync(socketPath)) rmSync(socketPath);
  let clients = 0;
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
  return {
    socketPath,
    tokenPath,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        rmSync(tokenPath, { force: true });
      }),
  };
}
