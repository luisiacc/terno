import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { isRpcMessage, RpcClient, type RpcMessage, type Transport } from "@unica/core/rpc";

export interface Endpoint {
  socketPath: string;
  tokenPath: string;
}

export function defaultEndpoint(): Endpoint {
  const dir = process.env.UNICA_USER_DATA ?? join(homedir(), "Library", "Application Support", "Única");
  return {
    socketPath: process.env.UNICA_SOCKET ?? join(dir, "agent.sock"),
    tokenPath: process.env.UNICA_TOKEN_FILE ?? join(dir, "agent.token"),
  };
}

export class NotRunningError extends Error {
  constructor() {
    super("Única is not running. Open the Única app and try again.");
  }
}

/** Connects to the running app's backend over its local socket (token handshake, then NDJSON RPC). */
export function connectToApp(endpoint: Endpoint): Promise<RpcClient> {
  return new Promise((resolve, reject) => {
    let token: string;
    try {
      token = readFileSync(endpoint.tokenPath, "utf8").trim();
    } catch {
      reject(new NotRunningError());
      return;
    }
    const socket = connect(endpoint.socketPath);
    socket.once("error", () => reject(new NotRunningError()));
    socket.once("connect", () => socket.write(`${token}\n`));
    let buffer = "";
    let authed = false;
    const listeners = new Set<(m: RpcMessage) => void>();
    const closeListeners = new Set<() => void>();
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (!authed) {
          if (msg.ok) {
            authed = true;
            const transport: Transport = {
              send: (m) => socket.write(`${JSON.stringify(m)}\n`),
              onMessage: (l) => (listeners.add(l), () => listeners.delete(l)),
              onClose: (l) => (closeListeners.add(l), () => closeListeners.delete(l)),
              close: () => socket.end(),
            };
            resolve(new RpcClient(transport, { defaultTimeoutMs: 60_000 }));
          } else {
            reject(new Error("Única rejected the connection (stale token). Restart Única."));
            socket.destroy();
          }
          continue;
        }
        if (isRpcMessage(msg)) for (const l of listeners) l(msg);
      }
    });
    socket.on("close", () => {
      for (const l of closeListeners) l();
    });
  });
}

/** Lazily (re)connects so the MCP server survives app restarts. */
export class AppConnection {
  private client: RpcClient | null = null;
  constructor(private readonly endpoint: Endpoint = defaultEndpoint()) {}

  async get(): Promise<RpcClient> {
    if (this.client) return this.client;
    const client = await connectToApp(this.endpoint);
    client.onClose(() => {
      if (this.client === client) this.client = null;
    });
    this.client = client;
    return client;
  }

  close(): void {
    this.client?.close();
    this.client = null;
  }
}
