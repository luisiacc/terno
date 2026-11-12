import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { profileDir } from "./profile";
import { isRpcMessage, RpcClient, RpcError, type MethodName, type ParamsOf, type ResultOf, type RpcMessage, type Transport } from "@terno/core/rpc";

export interface Endpoint {
  socketPath: string;
  tokenPath: string;
}

export function defaultEndpoint(): Endpoint {
  const dir = profileDir();
  return {
    socketPath: process.env.TERNO_SOCKET ?? join(dir, "agent.sock"),
    tokenPath: process.env.TERNO_TOKEN_FILE ?? join(dir, "agent.token"),
  };
}

export class NotRunningError extends Error {
  readonly expected = true;
  constructor() {
    // plan 183: no socket means Terno is closed or agents are off; it can't tell which, so it says both
    super("Can't reach Terno. Open Terno and turn on Settings → Agents → Allow agents, then try again.");
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
    // never hang a tool call: bound the handshake and fail if the app goes away mid-handshake
    const timer = setTimeout(() => {
      reject(new NotRunningError());
      socket.destroy();
    }, 5000);
    socket.once("close", () => {
      clearTimeout(timer);
      if (!authed) reject(new NotRunningError());
    });
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
            clearTimeout(timer);
            const transport: Transport = {
              send: (m) => socket.write(`${JSON.stringify(m)}\n`),
              onMessage: (l) => (listeners.add(l), () => listeners.delete(l)),
              onClose: (l) => (closeListeners.add(l), () => closeListeners.delete(l)),
              close: () => socket.end(),
            };
            resolve(new RpcClient(transport, { defaultTimeoutMs: 60_000 }));
          } else {
            reject(new Error("Terno rejected the connection (stale token). Restart Terno."));
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

  /**
   * One call on the live connection. If the connection closes under it (Terno quit, or the user turned agents off), the
   * agent hears what to do, not that a connection closed. Never retried: a send may have gone before the close.
   */
  async call<M extends MethodName>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>> {
    const client = await this.get();
    try {
      return await client.call(method, params);
    } catch (error) {
      if (error instanceof RpcError && error.code === "UNAVAILABLE" && this.client !== client) throw new NotRunningError();
      throw error;
    }
  }

  /** Resolves once no backend call is in flight (or after timeoutMs). */
  async drain(timeoutMs = 10_000): Promise<void> {
    const until = Date.now() + timeoutMs;
    while ((this.client?.pendingCount ?? 0) > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
  }

  close(): void {
    this.client?.close();
    this.client = null;
  }
}
